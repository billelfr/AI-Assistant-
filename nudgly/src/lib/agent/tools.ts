import { createClient } from "@/lib/supabase/server";

// 1. Define the structural type for how our internal registry maps functions
export interface ToolDefinition {
  declaration: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
  isGated?: boolean; // New flag to mark sensitive, gated tools
  execute: (userId: string, args: any) => Promise<any>;
}

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
      const supabase = await createClient();

      const { data, error } = await supabase
        .from("tasks")
        .insert({
          user_id: userId,
          title: args.title,
          description: args.description || null,
          due_at: args.due_at || null,
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
