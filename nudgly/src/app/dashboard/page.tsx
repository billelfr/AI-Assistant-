"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface Message {
  id?: string;
  sender: "user" | "agent";
  content: string;
}

export default function DashboardPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const supabase = createClient();
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 1. Load context status and historic logs on initial mount
  useEffect(() => {
    const fetchSessionAndChat = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      setUserEmail(user.email || "User");

      // Load existing message history
      const { data: history } = await supabase
        .from("chat_messages")
        .select("id, sender, content")
        .order("created_at", { ascending: true })
        .limit(50);

      if (history) {
        setMessages(history as Message[]);
      }
    };

    fetchSessionAndChat();
  }, [router, supabase]);

  // Auto-scroll chat container to the absolute bottom on new entries
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 2. Submit conversation turn to our API Agent Loop
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userText = input.trim();
    setInput("");
    setLoading(true);

    // Append local state immediately so user sees their text box update
    setMessages((prev) => [...prev, { sender: "user", content: userText }]);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText }),
      });

      const data = await response.json();

      if (response.ok && data.reply) {
        setMessages((prev) => [
          ...prev,
          { sender: "agent", content: data.reply },
        ]);

        // If the agent route flagged an approval requirement, trigger a state update or refresh!
        if (data.requiresApproval) {
          // We can force re-fetching message states from Supabase so the new state reflects instantly
          const { data: history } = await supabase
            .from("chat_messages")
            .select("id, sender, content")
            .order("created_at", { ascending: true });
          if (history) setMessages(history as Message[]);
        }
      } else {
        setMessages((prev) => [
          ...prev,
          {
            sender: "agent",
            content: `Error: ${data.error || "Failed to grab agent answer."}`,
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          sender: "agent",
          content: "System connection breakdown. Check your server logs.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-gray-100">
      {/* Top Banner Row */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
          <h1 className="text-xl font-bold tracking-tight">Nudgly Workspace</h1>
          <span className="text-xs text-gray-500 font-mono">[{userEmail}]</span>
        </div>
        <button
          onClick={handleLogout}
          className="rounded bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-700 transition"
        >
          Sign Out
        </button>
      </header>

      {/* Main Chat Flow Arena */}
      <main className="flex-1 overflow-y-auto p-6 space-y-4 max-w-4xl w-full mx-auto">
        {messages.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <p className="text-lg">Your workspace is quiet.</p>
            <p className="text-sm mt-1">
              Try saying:{" "}
              <span className="text-indigo-400 italic">
                "Remember to finish my compiler homework tomorrow"
              </span>
            </p>
          </div>
        )}

        {messages.map((msg, index) => {
          const isGatedMessage =
            msg.sender === "agent" && msg.content.includes("⚠️");

          return (
            <div
              key={index}
              className={`flex flex-col max-w-[75%] rounded-lg px-4 py-3 shadow-sm ${
                msg.sender === "user"
                  ? "bg-indigo-600 text-white ml-auto rounded-br-none"
                  : "bg-gray-800 border border-gray-700 text-gray-200 mr-auto rounded-bl-none"
              }`}
            >
              <span className="text-[10px] uppercase font-bold tracking-wider opacity-60 mb-1">
                {msg.sender === "user" ? "You" : "Nudgly"}
              </span>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {msg.content}
              </p>

              {/* Render interactive action gate controls if it's an intercept warning */}
              {isGatedMessage && (
                <div className="mt-3 flex gap-3 border-t border-gray-700 pt-3">
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/actions", {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            Accept: "application/json",
                          },
                          body: JSON.stringify({ decision: "approved" }),
                        });

                        if (!res.ok) {
                          const errorData = await res.json();
                          throw new Error(
                            errorData.error ||
                              "Backend failed to process approval",
                          );
                        }

                        // Force immediate UI synchronization by pulling fresh chat messages
                        const { data: updatedHistory } = await supabase
                          .from("chat_messages")
                          .select("id, sender, content")
                          .order("created_at", { ascending: true });

                        if (updatedHistory) {
                          setMessages(updatedHistory as any[]);
                        }
                      } catch (err) {
                        console.error("❌ Approval click handler crash:", err);
                      }
                    }}
                    className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 transition active:scale-95"
                  >
                    Confirm & Execute
                  </button>

                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/actions", {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            Accept: "application/json",
                          },
                          body: JSON.stringify({ decision: "rejected" }),
                        });

                        if (!res.ok) {
                          const errorData = await res.json();
                          throw new Error(
                            errorData.error ||
                              "Backend failed to process rejection",
                          );
                        }

                        const { data: updatedHistory } = await supabase
                          .from("chat_messages")
                          .select("id, sender, content")
                          .order("created_at", { ascending: true });

                        if (updatedHistory) {
                          setMessages(updatedHistory as any[]);
                        }
                      } catch (err) {
                        console.error("❌ Rejection click handler crash:", err);
                      }
                    }}
                    className="rounded bg-rose-600 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-500 transition active:scale-95"
                  >
                    Reject Action
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {loading && (
          <div className="bg-gray-850 border border-gray-800 text-gray-400 mr-auto rounded-lg rounded-bl-none px-4 py-3 max-w-[75%] flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
              style={{ animationDelay: "0ms" }}
            />
            <span
              className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
              style={{ animationDelay: "150ms" }}
            />
            <span
              className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
              style={{ animationDelay: "300ms" }}
            />
            <span className="text-xs ml-1 font-medium italic">
              Nudgly is processing...
            </span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* Persistent Base Input Row */}
      <footer className="border-t border-gray-800 bg-gray-950 p-4">
        <form
          onSubmit={handleSendMessage}
          className="max-w-4xl mx-auto flex gap-3"
        >
          <input
            type="text"
            required
            disabled={loading}
            placeholder="Instruct Nudgly..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 rounded-md border border-gray-800 bg-gray-900 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50 transition"
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
