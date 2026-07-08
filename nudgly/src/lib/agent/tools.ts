import { createClient } from "@/lib/supabase/server";

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

      const supabase = await createClient();

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
      const supabase = await createClient();

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

      const tasks = data ?? [];

      return {
        success: true,
        message:
          tasks.length === 0
            ? "You do not have any tasks yet."
            : `Found ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`,
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
      const supabase = await createClient();
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

  create_calendar_event: {
    declaration: {
      name: "create_calendar_event",
      description: "Schedules a new meeting or event on the user's calendar.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "The name of the meeting or event.",
          },
          start_time: {
            type: "string",
            description: "ISO string format of when the event starts.",
          },
          end_time: {
            type: "string",
            description: "ISO string format of when the event ends.",
          },
          description: {
            type: "string",
            description: "Optional notes or context about the event.",
          },
        },
        required: ["title", "start_time", "end_time"],
      },
    },
    execute: async (
      userId: string,
      args: ToolArgs,
    ): Promise<CalendarToolResult> => {
      try {
        const title = getStringArg(args, "title");
        const startTime = getStringArg(args, "start_time");
        const endTime = getStringArg(args, "end_time");
        const description = getStringArg(args, "description");

        if (!userId) {
          return {
            success: false,
            message: "Calendar event could not be scheduled.",
            error: "Missing user id.",
          };
        }

        if (!title || !startTime || !endTime) {
          return {
            success: false,
            message: "Calendar event could not be scheduled.",
            error: "Missing required calendar event fields.",
          };
        }

        const startDate = new Date(startTime);
        const endDate = new Date(endTime);

        if (
          Number.isNaN(startDate.getTime()) ||
          Number.isNaN(endDate.getTime()) ||
          endDate <= startDate
        ) {
          return {
            success: false,
            message: "Calendar event could not be scheduled.",
            error: "Invalid calendar event time range.",
          };
        }

        const supabase = await createClient();

        const { data, error } = await supabase
          .from("calendar_events")
          .insert({
            user_id: userId,
            title,
            start_time: startTime,
            end_time: endTime,
            description,
          })
          .select()
          .single();

        if (error) {
          console.log("❌ CALENDAR EVENT INSERTION FAILED:", error);
          return {
            success: false,
            message: "Calendar event could not be scheduled.",
            error: error.message,
          };
        }

        console.log("✅ CALENDAR EVENT INSERTION SUCCESS:", data);
        return {
          success: true,
          message: `Event "${title}" successfully added to your calendar.`,
          event: data,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown calendar error.";

        console.log("❌ CALENDAR EVENT TOOL CRASH:", error);
        return {
          success: false,
          message: "Calendar event could not be scheduled.",
          error: message,
        };
      }
    },
  },
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
