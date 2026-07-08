import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  toolRegistry,
  type ToolArgs,
  type ToolExecutionResult,
} from "@/lib/agent/tools";

type ActionDecision = "approved" | "rejected";

const parseActionRequest = (body: unknown) => {
  if (!body || typeof body !== "object") {
    return { actionId: null, decision: null };
  }

  const payload = body as Record<string, unknown>;
  const actionId =
    typeof payload.actionId === "string" && payload.actionId.trim()
      ? payload.actionId.trim()
      : null;
  const decision: ActionDecision | null =
    payload.decision === "approved" || payload.decision === "rejected"
      ? payload.decision
      : null;

  return { actionId, decision };
};

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsedRequest = parseActionRequest(await request.json());
    let actionId = parsedRequest.actionId;
    const decision = parsedRequest.decision;
    console.log("Received decision request:", { actionId, decision });

    if (!decision) {
      return NextResponse.json(
        { error: "Decision must be either approved or rejected." },
        { status: 400 },
      );
    }

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
      actionId =
        typeof latestAction.id === "string" && latestAction.id.trim()
          ? latestAction.id
          : null;

      if (!actionId) {
        return NextResponse.json(
          { error: "Pending action is missing a valid id." },
          { status: 500 },
        );
      }
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
    const toolName =
      typeof action.tool_name === "string" ? action.tool_name : "";
    const targetTool = toolRegistry[toolName];
    const actionArgs =
      action.arguments &&
      typeof action.arguments === "object" &&
      !Array.isArray(action.arguments)
        ? (action.arguments as ToolArgs)
        : {};
    let executionResult: ToolExecutionResult = {
      success: false,
      error: "Tool not found in registry",
    };

    if (targetTool) {
      executionResult = await targetTool.execute(user.id, actionArgs);
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
      content: `✅ Action Approved & Executed: ${executionResult.success ? "Success" : "Failed"}. ${toolName} completed.`,
    });

    return NextResponse.json({ success: true, result: executionResult });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal Server Error";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
