import { createClient as createSupabaseClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

type ToolParameterSchema = {
  type: string;
  description?: string;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
};

export type ToolArgs = Record<string, unknown>;

export interface ToolExecutionResult {
  success: boolean;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

// 1. Define the structural type for how our internal registry maps functions
export interface ToolDefinition {
  declaration: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameterSchema>;
      required?: string[];
    };
  };
  isGated?: boolean; // New flag to mark sensitive, gated tools
  execute: (userId: string, args: ToolArgs) => Promise<ToolExecutionResult>;
}

interface CalendarToolResult extends ToolExecutionResult {
  success: boolean;
  message: string;
  event?: unknown;
  error?: string;
}

interface TaskListResult extends ToolExecutionResult {
  success: boolean;
  message: string;
  tasks?: unknown[];
  error?: string;
}

const getStringArg = (args: ToolArgs, key: string) => {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const formatTaskDueLabel = (value?: string | null) => {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return ` • due ${date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
};

const formatTaskListDisplay = (tasks: Array<Record<string, unknown>>) => {
  if (!tasks.length) {
    return "You don’t have any tasks yet. I can help you add one.";
  }

  const lines = ["Here are your current tasks:"];

  tasks.forEach((task, index) => {
    const title = typeof task.title === "string" && task.title.trim() ? task.title.trim() : "Untitled task";
    const description = typeof task.description === "string" && task.description.trim() ? task.description.trim() : "";
    const dueLabel = formatTaskDueLabel(typeof task.due_at === "string" ? task.due_at : null);
    const status = typeof task.status === "string" && task.status.trim() ? task.status.trim().toLowerCase() : "pending";
    const statusLabel = status && status !== "pending" ? ` • ${status}` : "";

    lines.push(`${index + 1}. ${title}${statusLabel}${dueLabel}`);
    if (description) {
      lines.push(`   ${description}`);
    }
  });

  return lines.join("\n");
};

const getToolSupabaseClient = async () => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && serviceRoleKey) {
    return createSupabaseAdminClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return createSupabaseClient();
};

// 2. Implement the concrete tools inside our registry object
export const toolRegistry: Record<string, ToolDefinition> = {
  create_task: {
    declaration: {
      name: "create_task",
      description:
        "Creates a new task or to-do item for the user. Use this when the user explicitly asks to schedule, remember, or add a task.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              'The title or main objective of the task (e.g., "Buy groceries").',
          },
          description: {
            type: "string",
            description:
              "Optional additional details or context regarding the task.",
          },
          due_at: {
            type: "string",
            description:
              "Optional ISO timestamp indicating when the task is due.",
          },
        },
        required: ["title"],
      },
    },

    execute: async (userId, args) => {
      const title = getStringArg(args, "title");
      const description = getStringArg(args, "description");
      const dueAt = getStringArg(args, "due_at");

      if (!title) {
        return { success: false, error: "Task title is required." };
      }

      const supabase = await getToolSupabaseClient();

      const { data, error } = await supabase
        .from("tasks")
        .insert({
          user_id: userId,
          title,
          description,
          due_at: dueAt,
          status: "pending",
        })
        .select()
        .single();

      if (error) {
        console.log("❌ DATABASE INSERTION FAILED:", error);
        return { success: false, error: error.message };
      }

      console.log("✅ DATABASE INSERTION SUCCESS:", data);
      return { success: true, task: data };
    },
  },

  list_tasks: {
    declaration: {
      name: "list_tasks",
      description:
        "Shows all tasks for the user. Use this when the user asks to see, list, review, or summarize their tasks.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    execute: async (userId): Promise<TaskListResult> => {
      const supabase = await getToolSupabaseClient();

      const { data, error } = await supabase
        .from("tasks")
        .select("id, title, description, status, due_at, created_at")
        .eq("user_id", userId)
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false });

      if (error) {
        console.log("❌ TASK LIST FETCH FAILED:", error);
        return {
          success: false,
          message: "I could not load your tasks.",
          error: error.message,
        };
      }

      const tasks = (data ?? []) as Array<Record<string, unknown>>;
      const displayText = formatTaskListDisplay(tasks);

      return {
        success: true,
        message: displayText,
        displayText,
        tasks,
      };
    },
  },

  delete_all_tasks: {
    isGated: true, // This intercepts the execution loop automatically
    declaration: {
      name: "delete_all_tasks",
      description:
        "Deletes every single task in the user profile database. Use when the user wants to clear, wipe out, or reset their entire schedule.",
      parameters: {
        type: "object",
        properties: {}, // No params needed
      },
    },
    execute: async (userId) => {
      const supabase = await getToolSupabaseClient();
      const { error } = await supabase
        .from("tasks")
        .delete()
        .eq("user_id", userId);

      if (error) {
        console.log("❌ DATABASE DELETION FAILED:", error);
        return { success: false, error: error.message };
      }

      console.log("✅ ALL TASKS DELETED FOR USER:", userId);
      return { success: true, message: "All tasks successfully deleted." };
    },
  },

  schedule_telegram_alert: {
    isGated: false,
    declaration: {
      name: "schedule_telegram_alert",
      description: "Schedules a Telegram message reminder to be sent at a specific future date and time.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The message body to send to Telegram." },
          scheduled_for: {
            type: "string",
            description: "ISO-8601 string representing the exact time to send. Always compute this relative to the current time."
          }
        },
        required: ["message", "scheduled_for"]
      }
    },
    execute: async (userId: string, args: ToolArgs): Promise<ToolExecutionResult> => {
      try {
        const message = getStringArg(args, "message");
        const scheduled_for = getStringArg(args, "scheduled_for");

        if (!message || !scheduled_for) {
          return { success: false, error: "Both 'message' and 'scheduled_for' are required." };
        }

        // Interpret timezone-less datetimes as Africa/Algiers (UTC+1).
        // If the provided string already includes timezone info (Z or +HH[:MM]/-HH[:MM]),
        // parse directly. Otherwise, parse the date/time components and treat them as
        // Algeria local time then convert to a UTC instant for storage.
        const tzRegex = /[zZ]|[+\-]\d{2}(:?\d{2})?$/;
        const naiveIsoRegex = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

        let scheduledDate: Date | null = null;
        if (tzRegex.test(scheduled_for)) {
          scheduledDate = new Date(scheduled_for);
        } else {
          const m = scheduled_for.match(naiveIsoRegex);
          if (!m) {
            return { success: false, error: "'scheduled_for' must be an ISO date or datetime (e.g. 2026-07-11T09:00)." };
          }

          const year = Number(m[1]);
          const month = Number(m[2]);
          const day = Number(m[3]);
          const hour = Number(m[4] ?? "0");
          const minute = Number(m[5] ?? "0");
          const second = Number(m[6] ?? "0");

          // Algeria is UTC+1 and does not observe DST.
          const ALGIERS_OFFSET_HOURS = 1;

          // Create a UTC timestamp from the Algeria-local components by subtracting the offset.
          const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - ALGIERS_OFFSET_HOURS * 3600_000;
          scheduledDate = new Date(utcMillis);
        }

        if (!scheduledDate || Number.isNaN(scheduledDate.getTime())) {
          return { success: false, error: "'scheduled_for' could not be parsed as a valid datetime." };
        }

        const scheduledUtcIso = scheduledDate.toISOString();

        const supabase = await getToolSupabaseClient();

        const { data, error } = await supabase.from("scheduled_telegram_alerts").insert({
          user_id: userId,
          message,
          // store normalized UTC ISO string so cron worker can compare against server time
          scheduled_for: scheduledUtcIso,
          status: "pending",
        }).select().single();

        if (error) throw error;

        return {
          success: true,
          message: `I have scheduled your Telegram notification for: ${scheduledDate.toLocaleString()}`,
          alert: data,
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    }
  }

};

// Helper utility to export all tool declarations formatted directly for the Gemini SDK
export const getGeminiTools = () => {
  return [
    {
      functionDeclarations: Object.values(toolRegistry).map(
        (tool) => tool.declaration,
      ),
    },
  ];
};
