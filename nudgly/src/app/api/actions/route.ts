import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toolRegistry } from "@/lib/agent/tools";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let { actionId, decision } = await request.json();
    console.log("Received decision request:", { actionId, decision });

    // IF NO ACTION ID IS PASSED, AUTOMATICALLY FIND THE LATEST PENDING ONE ON THE SERVER
    if (!actionId) {
      const { data: latestAction, error: findError } = await supabase
        .from("pending_actions")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (findError || !latestAction) {
        return NextResponse.json(
          { error: "No pending actions found on the server." },
          { status: 404 },
        );
      }
      actionId = latestAction.id;
    }

    // 1. Fetch the specific action to process
    const { data: action, error: fetchError } = await supabase
      .from("pending_actions")
      .select("*")
      .eq("id", actionId)
      .single();

    if (fetchError || !action || action.status !== "pending") {
      return NextResponse.json(
        { error: "Action not found or already processed" },
        { status: 404 },
      );
    }

    // 2. If rejected, update status and short-circuit
    if (decision === "rejected") {
      await supabase
        .from("pending_actions")
        .update({ status: "rejected" })
        .eq("id", actionId);

      await supabase.from("chat_messages").insert({
        user_id: user.id,
        sender: "agent",
        content: `❌ Action cancelled: I have discarded the request to run ${action.tool_name}.`,
      });

      return NextResponse.json({ success: true, status: "rejected" });
    }

    // 3. If approved, run the tool execution logic securely on the server
    const targetTool = toolRegistry[action.tool_name];
    let executionResult = {
      success: false,
      error: "Tool not found in registry",
    };

    if (targetTool) {
      executionResult = await targetTool.execute(user.id, action.arguments);
    }

    // 4. Update the action status to approved
    await supabase
      .from("pending_actions")
      .update({ status: "approved" })
      .eq("id", actionId);

    // 5. Post the final completion message back to the chat timeline
    await supabase.from("chat_messages").insert({
      user_id: user.id,
      sender: "agent",
      content: `✅ Action Approved & Executed: ${executionResult.success ? "Success" : "Failed"}. ${action.tool_name} completed.`,
    });

    return NextResponse.json({ success: true, result: executionResult });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
