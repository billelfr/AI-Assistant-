import { createClient as createSupabaseClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import { toolRegistry } from "@/lib/agent/tools";

export const dynamic = "force-dynamic";

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

async function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && serviceRoleKey) {
    return createSupabaseAdminClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return createSupabaseClient();
}

function normalizePhoneNumber(rawValue: string) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }

  const withoutPrefix = trimmed.replace(/^whatsapp:/i, "").trim();
  const cleaned = withoutPrefix.replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\D/g, "");

  return cleaned.startsWith("+") ? `+${digits}` : digits;
}

async function findProfileByPhone(supabase: Awaited<ReturnType<typeof getSupabaseClient>>, phoneValue: string) {
  const normalizedPhone = normalizePhoneNumber(phoneValue);
  const candidates = [normalizedPhone];

  if (normalizedPhone.startsWith("+")) {
    candidates.push(normalizedPhone.slice(1));
  } else if (normalizedPhone) {
    candidates.push(`+${normalizedPhone}`);
  }

  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));

  for (const candidate of uniqueCandidates) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name")
      .eq("phone_number", candidate)
      .maybeSingle();

    if (!error && data) {
      return { data, error: null };
    }
  }

  return { data: null, error: null };
}

export async function GET() {
  return new Response("ok", { status: 200 });
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/x-www-form-urlencoded")) {
      return new Response("Expected urlencoded form data.", { status: 400 });
    }

    const formData = await request.formData();
    const from = formData.get("From") as string | null;
    const body = formData.get("Body") as string | null;

    if (!from || !body) {
      return new Response("Missing Form Fields.", { status: 400 });
    }

    const messageText = body.trim();

    const supabase = await getSupabaseClient();

    const { data: profile, error: dbError } = await findProfileByPhone(supabase, from);

    if (dbError) {
      console.error("WhatsApp profile lookup failed:", dbError);
      return sendTwiMLResponse("System error. Please try again later.");
    }

    if (!profile) {
      const onboardingMsg = `👋 Welcome to Nudgly! Your phone number (${from}) isn't registered yet. Please log into your dashboard and link this phone number to start using WhatsApp.`;
      return sendTwiMLResponse(onboardingMsg);
    }

    const replyText = await runAgentForUser({
      userId: profile.id,
      message: messageText,
      channel: "whatsapp",
      userName: profile.full_name,
      supabase,
    });

    return sendTwiMLResponse(replyText);
  } catch (err: any) {
    console.error("WhatsApp webhook error:", err);
    return new Response(`Webhook Error: ${err?.message ?? String(err)}`, {
      status: 500,
    });
  }
}

async function runAgentForUser({
  userId,
  message,
  channel,
  userName,
  supabase,
}: {
  userId: string;
  message: string;
  channel: string;
  userName?: string | null;
  supabase: Awaited<ReturnType<typeof createSupabaseClient>>;
}) {
  try {
    await supabase.from("chat_messages").insert({
      user_id: userId,
      sender: "user",
      content: message,
      channel,
    });
  } catch (insertError) {
    console.error("Failed to store incoming WhatsApp message:", insertError);
  }

  if (!ai) {
    const fallbackReply = `Hi ${userName || "there"}, I am ready to help. Your message was: “${message}”.`;
    try {
      await supabase.from("chat_messages").insert({
        user_id: userId,
        sender: "agent",
        content: fallbackReply,
        channel,
      });
    } catch (persistError) {
      console.error("Failed to store fallback WhatsApp reply:", persistError);
    }

    return fallbackReply;
  }

  const { data: history } = await supabase
    .from("chat_messages")
    .select("sender, content")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(20);

  const contents: Content[] =
    history?.map((msg: { sender: string; content: string }) => ({
      role: msg.sender === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    })) || [];

  const lastMessageText = contents.at(-1)?.parts?.[0]?.text;
  if (lastMessageText !== message) {
    contents.push({ role: "user", parts: [{ text: message }] });
  }

  const formattedTools = Object.values(toolRegistry).map(
    (tool) => tool.declaration,
  ) as unknown as FunctionDeclaration[];

  const systemInstruction = `You are Nudgly, an autonomous personal executive assistant. You manage tasks, schedules, and workflows. When an action is required, proactively execute tools. Always speak politely and clearly confirm when actions or tasks are successfully handled.`;

  let response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents,
    config: {
      systemInstruction,
      tools: [{ functionDeclarations: formattedTools }],
    },
  });

  let functionCalls = response.functionCalls;

  while (functionCalls && functionCalls.length > 0) {
    const currentCall = functionCalls[0];
    const toolName = currentCall.name;
    const toolArgs = currentCall.args ?? {};

    if (toolName && toolRegistry[toolName]) {
      const targetTool = toolRegistry[toolName];

      if (targetTool.isGated) {
        await supabase.from("pending_actions").insert({
          user_id: userId,
          tool_name: toolName,
          arguments: toolArgs,
        });

        const actionName = toolName.replace(/_/g, " ").toLowerCase();
        const gateReply = `⚠️ I’m preparing to execute an action "${actionName}". Please review and confirm it on your dashboard before I proceed.`;

        await supabase.from("chat_messages").insert({
          user_id: userId,
          sender: "agent",
          content: gateReply,
          channel,
        });

        return gateReply;
      }

      const toolResult = await targetTool.execute(userId, toolArgs);

      if (toolName === "list_tasks" && typeof toolResult.displayText === "string") {
        const formattedReply = toolResult.displayText;

        try {
          await supabase.from("chat_messages").insert({
            user_id: userId,
            sender: "agent",
            content: formattedReply,
            channel,
          });
        } catch (persistError) {
          console.error("Failed to store formatted task-list reply:", persistError);
        }

        return formattedReply;
      }

      contents.push({ role: "model", parts: [{ functionCall: currentCall }] });
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: toolName, response: toolResult } }],
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

  const finalReplyText = response.text || "I’ve processed that request for you.";

  try {
    await supabase.from("chat_messages").insert({
      user_id: userId,
      sender: "agent",
      content: finalReplyText,
      channel,
    });
  } catch (persistError) {
    console.error("Failed to store agent reply:", persistError);
  }

  return finalReplyText;
}

function sendTwiMLResponse(text: string) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>${escapeXml(text)}</Message>
</Response>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml" },
    status: 200,
  });
}

function escapeXml(unsafe: string) {
  return unsafe.replace(/[<>&'"']/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}
