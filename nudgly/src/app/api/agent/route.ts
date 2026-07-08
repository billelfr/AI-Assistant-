import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
} from "@google/genai";
import { toolRegistry } from "@/lib/agent/tools";

// Initialize the official Google Gen AI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const parseAgentRequest = (body: unknown) => {
  if (!body || typeof body !== "object") {
    return { message: "", channel: "web" };
  }

  const payload = body as Record<string, unknown>;
  const message = typeof payload.message === "string" ? payload.message : "";
  const channel = typeof payload.channel === "string" ? payload.channel : "web";

  return { message: message.trim(), channel };
};

export async function POST(request: Request) {
  try {
    // 1. Authenticate user session securely via cookies
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized access" },
        { status: 401 },
      );
    }

    const { message, channel } = parseAgentRequest(await request.json());
    if (!message) {
      return NextResponse.json(
        { error: "Message field required" },
        { status: 400 },
      );
    }

    const userId = user.id;

    // 2. Log the incoming user message to Supabase
    await supabase.from("chat_messages").insert({
      user_id: userId,
      sender: "user",
      content: message,
      channel,
    });

    // 3. Fetch recent conversation history to provide memory context
    const { data: history } = await supabase
      .from("chat_messages")
      .select("sender, content")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(20);

    // 4. Format history records explicitly into the structure the SDK expects
    const contents: Content[] =
      history?.map((msg) => ({
        role: msg.sender === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      })) || [];

    // Append current message if history didn't catch it yet
    const lastMessageText = contents.at(-1)?.parts?.[0]?.text;
    if (lastMessageText !== message) {
      contents.push({ role: "user", parts: [{ text: message }] });
    }

    // 5. Map our tool definitions array into the SDK format
    const formattedTools = Object.values(toolRegistry).map(
      (tool) => tool.declaration,
    ) as unknown as FunctionDeclaration[];

    const systemInstruction = `You are Nudgly, an autonomous personal executive assistant. 
    You manage tasks, schedules, and workflows. When an action is required, proactively execute tools. 
    Always speak politely and clearly confirm when actions or tasks are successfully handled.`;

    // 6. First call to Gemini
    let response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: formattedTools }],
      },
    });

    // 7. Process function calls loop if requested
    let functionCalls = response.functionCalls;

    while (functionCalls && functionCalls.length > 0) {
      const currentCall = functionCalls[0];
      const toolName = currentCall.name;
      const toolArgs = currentCall.args ?? {};

      if (toolName && toolRegistry[toolName]) {
        const targetTool = toolRegistry[toolName];

        // CHECK FOR APPROVAL GATE INTERCEPT
        if (targetTool.isGated) {
          // 1. Save the action to the database as pending
          await supabase.from("pending_actions").insert({
            user_id: userId,
            tool_name: toolName,
            arguments: toolArgs,
          });

          // 2. Format a message that our dashboard frontend knows how to parse for approval buttons
          const actionName = toolName.replace(/_/g, " ").toLowerCase();

          const gateReply = `⚠️ I'm preparing to execute an action "${actionName}". Please review and confirm this request on your dashboard before I proceed.`;

          // 3. Save the intercept notification to the chat history table
          await supabase.from("chat_messages").insert({
            user_id: userId,
            sender: "agent",
            content: gateReply,
            channel,
          });

          // 4. Return early so the loop breaks and prompts the UI card element
          return NextResponse.json({
            reply: gateReply,
            requiresApproval: true,
          });
        }

        // Otherwise, execute non-gated tools (like create_task) automatically
        const toolResult = await targetTool.execute(userId, toolArgs);

        contents.push({
          role: "model",
          parts: [{ functionCall: currentCall }],
        });

        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: toolName,
                response: toolResult,
              },
            },
          ],
        });

        response = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: formattedTools }],
          },
        });

        functionCalls = response.functionCalls;
      } else {
        break;
      }
    }

    // 8. Grab the clean text string output
    const finalReplyText =
      response.text || "I've processed that request for you.";

    // 9. Save agent reply back to our chat database
    await supabase.from("chat_messages").insert({
      user_id: userId,
      sender: "agent",
      content: finalReplyText,
      channel,
    });

    return NextResponse.json({ reply: finalReplyText });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal Server Error";

    console.error("Agent Engine Error:", error);
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
