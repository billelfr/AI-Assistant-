"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

interface Message {
  id?: string;
  sender: "user" | "agent";
  content: string;
}

interface BrowserNotificationPayload {
  title?: string | null;
  body?: string | null;
}

interface Task {
  id: string;
  title: string;
  description?: string | null;
  status?: string | null;
  due_at?: string | null;
  created_at?: string | null;
}

type TaskViewMode = "list" | "cards";

const formatTaskDueLabel = (value?: string | null) => {
  if (!value) {
    return "No due date";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Invalid date";
  }

  const formattedDate = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

  return `Due ${formattedDate}`;
};

const formatTaskStatus = (status?: string | null) =>
  status ? status.replace(/_/g, " ") : "pending";

const getStatusClassName = (status?: string | null) => {
  switch (status) {
    case "completed":
    case "done":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
    case "cancelled":
    case "canceled":
      return "border-rose-500/40 bg-rose-500/10 text-rose-300";
    case "in_progress":
      return "border-sky-500/40 bg-sky-500/10 text-sky-300";
    default:
      return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  }
};

export default function DashboardPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskViewMode, setTaskViewMode] = useState<TaskViewMode>("list");
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const refreshTasks = useCallback(
    async (targetUserId: string) => {
      setTasksLoading(true);
      setTasksError(null);

      const { data, error } = await supabase
        .from("tasks")
        .select("id, title, description, status, due_at, created_at")
        .eq("user_id", targetUserId)
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false });

      if (error) {
        setTasksError(error.message);
        setTasks([]);
      } else {
        setTasks((data ?? []) as Task[]);
      }

      setTasksLoading(false);
    },
    [supabase],
  );

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
      setUserId(user.id);
      await refreshTasks(user.id);

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
  }, [refreshTasks, router, supabase]);

  // Keep the task panel in sync with tool executions when realtime is enabled
  useEffect(() => {
    if (!userId) {
      return;
    }

    const channel = supabase
      .channel(`dashboard-tasks:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tasks",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void refreshTasks(userId);
        },
      )
      .subscribe((status, error) => {
        if (error) {
          console.error("❌ Task realtime subscription failed:", {
            status,
            error,
          });
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refreshTasks, supabase, userId]);

  // Native browser notifications powered by Supabase Realtime inserts
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }

    if (!userId) {
      return;
    }

    if (Notification.permission === "default") {
      void Notification.requestPermission().catch((error) => {
        console.error("❌ Notification permission request failed:", error);
      });
    }

    const channel = supabase
      .channel(`dashboard-notifications:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (Notification.permission !== "granted") {
            return;
          }

          const insertedNotification =
            payload.new as BrowserNotificationPayload;
          const title = insertedNotification.title?.trim();

          if (!title) {
            return;
          }

          new Notification(title, {
            body: insertedNotification.body?.trim() || undefined,
          });
        },
      )
      .subscribe((status, error) => {
        if (error) {
          console.error("❌ Notification realtime subscription failed:", {
            status,
            error,
          });
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, userId]);

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
        if (userId) {
          void refreshTasks(userId);
        }

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
    } catch {
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

  const openTaskCount = tasks.filter((task) => {
    const status = task.status?.toLowerCase();
    return (
      status !== "completed" &&
      status !== "done" &&
      status !== "cancelled" &&
      status !== "canceled"
    );
  }).length;

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-gray-100">
      {/* Top Banner Row */}
      <header className="flex flex-col gap-3 border-b border-gray-800 bg-gray-950 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-3 w-3 shrink-0 rounded-full bg-emerald-500 animate-pulse" />
          <h1 className="shrink-0 text-xl font-bold tracking-tight">
            Nudgly Workspace
          </h1>
          <span className="min-w-0 truncate text-xs text-gray-500 font-mono">
            [{userEmail}]
          </span>
        </div>
        <button
          onClick={handleLogout}
          className="min-h-11 rounded bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700 transition"
        >
          Sign Out
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4 lg:overflow-hidden lg:p-6">
        <div className="mx-auto grid min-h-full w-full max-w-7xl gap-4 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
          {/* Main Chat Flow Arena */}
          <section className="flex min-h-[28rem] flex-col lg:min-h-0">
            <div className="flex-1 space-y-4 lg:overflow-y-auto lg:pr-1">
              {messages.length === 0 && (
                <div className="text-center py-12 text-gray-500">
                  <p className="text-lg">Your workspace is quiet.</p>
                  <p className="text-sm mt-1">
                    Try saying:{" "}
                    <span className="text-indigo-400 italic">
                      &quot;Remember to finish my compiler homework
                      tomorrow&quot;
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
                    className={`flex max-w-[88%] flex-col rounded-lg px-4 py-3 shadow-sm sm:max-w-[75%] ${
                      msg.sender === "user"
                        ? "bg-indigo-600 text-white ml-auto rounded-br-none"
                        : "bg-gray-800 border border-gray-700 text-gray-200 mr-auto rounded-bl-none"
                    }`}
                  >
                    <span className="text-[10px] uppercase font-bold tracking-wider opacity-60 mb-1">
                      {msg.sender === "user" ? "You" : "Nudgly"}
                    </span>
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {msg.content}
                    </p>

                    {/* Render interactive action gate controls if it's an intercept warning */}
                    {isGatedMessage && (
                      <div className="mt-3 flex flex-wrap gap-3 border-t border-gray-700 pt-3">
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetch("/api/actions", {
                                method: "POST",
                                headers: {
                                  "Content-Type": "application/json",
                                  Accept: "application/json",
                                },
                                body: JSON.stringify({
                                  decision: "approved",
                                }),
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
                                setMessages(updatedHistory as Message[]);
                              }

                              if (userId) {
                                void refreshTasks(userId);
                              }
                            } catch (err) {
                              console.error(
                                "❌ Approval click handler crash:",
                                err,
                              );
                            }
                          }}
                          className="min-h-11 rounded bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition active:scale-95"
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
                                body: JSON.stringify({
                                  decision: "rejected",
                                }),
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
                                setMessages(updatedHistory as Message[]);
                              }
                            } catch (err) {
                              console.error(
                                "❌ Rejection click handler crash:",
                                err,
                              );
                            }
                          }}
                          className="min-h-11 rounded bg-rose-600 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-500 transition active:scale-95"
                        >
                          Reject Action
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {loading && (
                <div className="mr-auto flex max-w-[88%] items-center gap-2 rounded-lg rounded-bl-none border border-gray-800 bg-gray-800 px-4 py-3 text-gray-400 sm:max-w-[75%]">
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
            </div>
          </section>

          <aside className="border-t border-gray-800 pt-4 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between lg:flex-col">
              <div>
                <h2 className="text-lg font-semibold text-white">Tasks</h2>
                <p className="mt-1 text-sm text-gray-400">
                  {tasksLoading
                    ? "Loading tasks"
                    : `${tasks.length} total, ${openTaskCount} open`}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <div className="inline-flex rounded-md border border-gray-800 bg-gray-950 p-1">
                  <button
                    type="button"
                    aria-pressed={taskViewMode === "list"}
                    onClick={() => setTaskViewMode("list")}
                    className={`min-h-11 rounded px-3 text-sm font-medium transition ${
                      taskViewMode === "list"
                        ? "bg-gray-700 text-white"
                        : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                    }`}
                  >
                    List
                  </button>
                  <button
                    type="button"
                    aria-pressed={taskViewMode === "cards"}
                    onClick={() => setTaskViewMode("cards")}
                    className={`min-h-11 rounded px-3 text-sm font-medium transition ${
                      taskViewMode === "cards"
                        ? "bg-gray-700 text-white"
                        : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                    }`}
                  >
                    Cards
                  </button>
                </div>

                <button
                  type="button"
                  disabled={!userId || tasksLoading}
                  onClick={() => {
                    if (userId) {
                      void refreshTasks(userId);
                    }
                  }}
                  className="min-h-11 rounded-md border border-gray-800 px-3 text-sm font-medium text-gray-300 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Refresh
                </button>
              </div>
            </div>

            {tasksError && (
              <div className="mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
                {tasksError}
              </div>
            )}

            {tasksLoading && (
              <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4 text-sm text-gray-400">
                Loading your tasks...
              </div>
            )}

            {!tasksLoading && tasks.length === 0 && (
              <div className="rounded-lg border border-dashed border-gray-800 p-4 text-sm text-gray-400">
                No tasks yet. Ask Nudgly to remember something and it will show
                up here.
              </div>
            )}

            {!tasksLoading && tasks.length > 0 && taskViewMode === "list" && (
              <div className="divide-y divide-gray-800 overflow-hidden rounded-lg border border-gray-800">
                {tasks.map((task) => (
                  <article key={task.id} className="bg-gray-950/40 p-3">
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between lg:flex-col xl:flex-row">
                        <h3 className="break-words text-sm font-semibold text-white">
                          {task.title}
                        </h3>
                        <span
                          className={`inline-flex w-fit items-center rounded border px-2 py-1 text-xs font-semibold capitalize ${getStatusClassName(
                            task.status,
                          )}`}
                        >
                          {formatTaskStatus(task.status)}
                        </span>
                      </div>

                      {task.description && (
                        <p className="break-words text-sm leading-relaxed text-gray-400">
                          {task.description}
                        </p>
                      )}

                      <p className="text-xs font-medium text-gray-500">
                        {formatTaskDueLabel(task.due_at)}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {!tasksLoading && tasks.length > 0 && taskViewMode === "cards" && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                {tasks.map((task) => (
                  <article
                    key={task.id}
                    className="rounded-lg border border-gray-800 bg-gray-950/70 p-4 shadow-sm"
                  >
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <h3 className="break-words text-sm font-semibold leading-6 text-white">
                        {task.title}
                      </h3>
                      <span
                        className={`inline-flex shrink-0 items-center rounded border px-2 py-1 text-xs font-semibold capitalize ${getStatusClassName(
                          task.status,
                        )}`}
                      >
                        {formatTaskStatus(task.status)}
                      </span>
                    </div>

                    {task.description && (
                      <p className="mb-4 break-words text-sm leading-relaxed text-gray-400">
                        {task.description}
                      </p>
                    )}

                    <div className="border-t border-gray-800 pt-3 text-xs font-medium text-gray-500">
                      {formatTaskDueLabel(task.due_at)}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </aside>
        </div>
      </main>

      {/* Persistent Base Input Row */}
      <footer className="border-t border-gray-800 bg-gray-950 p-4">
        <form
          onSubmit={handleSendMessage}
          className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row"
        >
          <input
            type="text"
            required
            disabled={loading}
            placeholder="Instruct Nudgly..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="min-h-11 flex-1 rounded-md border border-gray-800 bg-gray-900 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={loading}
            className="min-h-11 rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50 transition"
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
