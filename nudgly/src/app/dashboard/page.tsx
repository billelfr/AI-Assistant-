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
type DashboardView = "chat" | "tasks" | "phone";

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

const normalizePhoneNumber = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const cleaned = trimmed.replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\D/g, "");

  return cleaned.startsWith("+") ? `+${digits}` : digits;
};

const buildWhatsAppLink = (value: string) => {
  const normalized = normalizePhoneNumber(value);
  if (!normalized) {
    return "https://wa.me/";
  }

  const digits = normalized.startsWith("+")
    ? normalized.slice(1)
    : normalized;

  return `https://wa.me/${digits}`;
};

const getStatusClassName = (status?: string | null) => {
  switch (status) {
    case "completed":
    case "done":
      return "border-gray-700 bg-gray-800 text-emerald-400";
    case "cancelled":
    case "canceled":
      return "border-gray-700 bg-gray-800 text-rose-400";
    default:
      return "border-gray-700 bg-gray-800 text-gray-400";
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
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<DashboardView>("chat");
  const [linkedPhoneNumber, setLinkedPhoneNumber] = useState("");
  const [phoneNumberInput, setPhoneNumberInput] = useState("");
  const [phoneNumberLoading, setPhoneNumberLoading] = useState(false);
  const [phoneNumberError, setPhoneNumberError] = useState<string | null>(null);
  const [phoneNumberSuccess, setPhoneNumberSuccess] = useState<string | null>(null);

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

      const { data: profileData } = await supabase
        .from("profiles")
        .select("phone_number")
        .eq("id", user.id)
        .maybeSingle();

      const existingPhoneNumber = profileData?.phone_number?.toString() || "";
      setLinkedPhoneNumber(existingPhoneNumber);
      setPhoneNumberInput(existingPhoneNumber);

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

  const handleSavePhoneNumber = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!userId) {
      setPhoneNumberError("You need to be signed in before linking a phone number.");
      return;
    }

    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumberInput);
    if (!normalizedPhoneNumber) {
      setPhoneNumberError("Please enter a phone number before saving.");
      setPhoneNumberSuccess(null);
      return;
    }

    setPhoneNumberLoading(true);
    setPhoneNumberError(null);
    setPhoneNumberSuccess(null);

    try {
      const { error } = await supabase
        .from("profiles")
        .upsert({ id: userId, phone_number: normalizedPhoneNumber }, { onConflict: "id" });

      if (error) {
        throw error;
      }

      setLinkedPhoneNumber(normalizedPhoneNumber);
      setPhoneNumberInput(normalizedPhoneNumber);
      setPhoneNumberSuccess("Phone number linked successfully.");
    } catch (error: unknown) {
      console.error("❌ Failed to save phone number:", error);
      setPhoneNumberError(
        error instanceof Error ? error.message : "Unable to save the phone number right now.",
      );
    } finally {
      setPhoneNumberLoading(false);
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

  const handleSendTasksToGmail = useCallback(async () => {
    if (!tasks.length) {
      setEmailStatus("Add at least one task before sending it to Gmail.");
      return;
    }

    setEmailStatus("Sending your tasks to your email…");

    try {
      const response = await fetch("/api/tasks/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || "Unable to send your tasks right now.");
      }

      setEmailStatus(`Tasks sent to ${userEmail || "your email"}.`);
    } catch (error) {
      setEmailStatus(
        error instanceof Error ? error.message : "Unable to send your tasks right now.",
      );
    }
  }, [tasks, userEmail]);

  const navigationItems: Array<{ id: DashboardView; label: string; description: string }> = [
    { id: "chat", label: "Chat", description: "Talk with Nudgly" },
    { id: "tasks", label: "Tasks", description: "Review reminders" },
    { id: "phone", label: "Link phone", description: "Connect WhatsApp" },
  ];

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-gray-100">
      {/* Top Banner Row */}
      <header className="flex flex-col gap-3 border-b border-gray-800 bg-gray-950 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="shrink-0 text-base font-semibold text-white">Nudgly</h1>
          <span className="min-w-0 truncate text-sm text-gray-500">{userEmail}</span>
        </div>
        <button
          onClick={handleLogout}
          className="min-h-11 rounded-md border border-gray-800 px-4 py-2 text-sm font-medium text-gray-400 hover:border-gray-600 hover:text-white transition-colors"
        >
          Sign out
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4 lg:overflow-hidden lg:p-6">
        <div className="mx-auto flex h-full min-h-full w-full max-w-7xl flex-col gap-4 lg:flex-row lg:items-stretch">
          <aside className="w-full shrink-0 rounded-2xl border border-gray-800 bg-gray-900/70 p-3 lg:w-64 lg:p-4">
            <div className="mb-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
                Workspace
              </p>
            </div>
            <nav className="flex flex-col gap-2">
              {navigationItems.map((item) => {
                const isActive = activeView === item.id;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveView(item.id)}
                    className={`rounded-xl border px-3 py-3 text-left transition-colors ${isActive
                      ? "border-indigo-500 bg-indigo-600/15 text-white"
                      : "border-gray-800 bg-gray-950/70 text-gray-400 hover:border-gray-700 hover:bg-gray-900 hover:text-white"
                      }`}
                  >
                    <div className="text-sm font-semibold">{item.label}</div>
                    <div className="mt-1 text-xs text-gray-500">{item.description}</div>
                  </button>
                );
              })}
            </nav>
          </aside>

          <section className="flex min-h-[28rem] flex-1 flex-col rounded-2xl border border-gray-800 bg-gray-950/70 p-3 sm:p-4 lg:min-h-0">
            {activeView === "chat" ? (
              <div className="flex h-full flex-col">
                <div className="mb-4 border-b border-gray-800 pb-4">
                  <h2 className="text-lg font-semibold text-white">Chat</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Start a conversation with Nudgly and review any approvals here.
                  </p>
                </div>

                <div className="flex-1 space-y-4 overflow-y-auto pr-1">
                  {messages.length === 0 && (
                    <div className="py-16 text-center">
                      <p className="text-sm font-medium text-gray-500">Your workspace is quiet.</p>
                      <p className="mt-2 text-sm text-gray-600">
                        Try:{" "}
                        <span className="text-indigo-400">
                          &quot;Remember to finish my compiler homework tomorrow&quot;
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
                        className={`flex max-w-[88%] flex-col rounded-xl px-4 py-3 sm:max-w-[75%] ${msg.sender === "user"
                          ? "ml-auto bg-indigo-600 text-white"
                          : "mr-auto border border-gray-800 bg-gray-900 text-gray-300"
                          }`}
                      >
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                          {msg.content}
                        </p>

                        {isGatedMessage && (
                          <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-800 pt-3">
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
                              className="min-h-11 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
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
                              className="min-h-11 rounded-md border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {loading && (
                    <div className="mr-auto flex max-w-[88%] items-center gap-2 rounded-xl border border-gray-800 bg-gray-900 px-4 py-3 text-gray-500 sm:max-w-[75%]">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-700" style={{ animationDelay: "0ms" }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-700" style={{ animationDelay: "150ms" }} />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-700" style={{ animationDelay: "300ms" }} />
                      <span className="ml-1 text-xs text-gray-500">Nudgly is thinking…</span>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </div>
            ) : activeView === "tasks" ? (
              <div className="flex h-full flex-col">
                <div className="mb-4 border-b border-gray-800 pb-4">
                  <h2 className="text-lg font-semibold text-white">Tasks</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Keep track of reminders and agent-generated work.
                  </p>
                </div>

                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm text-gray-500">
                      {tasksLoading
                        ? "Loading…"
                        : `${tasks.length} total · ${openTaskCount} open`}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <div className="inline-flex rounded-md border border-gray-800 p-0.5">
                      <button
                        type="button"
                        aria-pressed={taskViewMode === "list"}
                        onClick={() => setTaskViewMode("list")}
                        className={`min-h-11 rounded px-3 text-sm font-medium transition-colors ${taskViewMode === "list"
                          ? "bg-gray-800 text-white"
                          : "text-gray-500 hover:text-gray-300"
                          }`}
                      >
                        List
                      </button>
                      <button
                        type="button"
                        aria-pressed={taskViewMode === "cards"}
                        onClick={() => setTaskViewMode("cards")}
                        className={`min-h-11 rounded px-3 text-sm font-medium transition-colors ${taskViewMode === "cards"
                          ? "bg-gray-800 text-white"
                          : "text-gray-500 hover:text-gray-300"
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
                      className="min-h-11 rounded-md border border-gray-800 px-3 text-sm font-medium text-gray-500 transition-colors hover:border-gray-700 hover:text-gray-300 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Refresh
                    </button>

                    <button
                      type="button"
                      disabled={tasksLoading || tasks.length === 0}
                      onClick={handleSendTasksToGmail}
                      className="min-h-11 rounded-md border border-indigo-500/30 bg-indigo-600/10 px-3 text-sm font-medium text-indigo-300 transition-colors hover:bg-indigo-600/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Send to Gmail
                    </button>
                  </div>
                </div>

                {emailStatus ? (
                  <p className="mb-3 text-sm text-emerald-400">{emailStatus}</p>
                ) : null}

                <div className="flex-1 overflow-y-auto pr-1">
                  {tasksError && (
                    <div className="mb-3 rounded-md border border-rose-500/20 p-3 text-sm text-rose-400">
                      {tasksError}
                    </div>
                  )}

                  {tasksLoading && (
                    <div className="py-4 text-sm text-gray-500">Loading tasks…</div>
                  )}

                  {!tasksLoading && tasks.length === 0 && (
                    <div className="py-4 text-sm text-gray-600">
                      No tasks yet. Ask Nudgly to remember something.
                    </div>
                  )}

                  {!tasksLoading && tasks.length > 0 && taskViewMode === "list" && (
                    <div className="divide-y divide-gray-800 overflow-hidden rounded-lg border border-gray-800">
                      {tasks.map((task) => (
                        <article key={task.id} className="p-3 transition-colors hover:bg-gray-900">
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
                    <div className="grid gap-3 sm:grid-cols-2">
                      {tasks.map((task) => (
                        <article
                          key={task.id}
                          className="rounded-lg border border-gray-800 p-4"
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
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                <div className="mb-4 border-b border-gray-800 pb-4">
                  <h2 className="text-lg font-semibold text-white">Link phone</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Connect a number so WhatsApp messages can reach this workspace.
                  </p>
                </div>

                <div className="flex-1 overflow-y-auto pr-1">
                  <form onSubmit={handleSavePhoneNumber} className="space-y-2">
                    <label className="text-xs font-medium text-gray-500">
                      Phone number
                    </label>
                    <input
                      value={phoneNumberInput}
                      onChange={(event) => {
                        setPhoneNumberInput(event.target.value);
                        if (phoneNumberError) {
                          setPhoneNumberError(null);
                        }
                      }}
                      placeholder="+1 555 123 4567"
                      className="w-full min-h-11 rounded-md border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-white outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-500"
                    />
                    <button
                      type="submit"
                      disabled={phoneNumberLoading}
                      className="min-h-11 w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {phoneNumberLoading ? "Saving…" : "Link phone number"}
                    </button>
                  </form>

                  {phoneNumberError ? (
                    <p className="mt-2 text-sm text-rose-400">{phoneNumberError}</p>
                  ) : null}

                  {phoneNumberSuccess ? (
                    <p className="mt-2 text-sm text-emerald-400">{phoneNumberSuccess}</p>
                  ) : null}

                  {linkedPhoneNumber ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-900/70 p-3">
                      <span className="text-sm text-gray-400">{linkedPhoneNumber}</span>
                      <a
                        href={buildWhatsAppLink(linkedPhoneNumber)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                      >
                        Open WhatsApp
                      </a>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-gray-600">
                      Save a number above to start a WhatsApp chat from this dashboard.
                    </p>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {activeView === "chat" ? (
        <footer className="border-t border-gray-800 bg-gray-950 px-4 py-3">
          <form
            onSubmit={handleSendMessage}
            className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row"
          >
            <input
              type="text"
              required
              disabled={loading}
              placeholder="Message Nudgly…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="min-h-11 flex-1 rounded-md border border-gray-800 bg-gray-900 px-4 py-2.5 text-sm text-white placeholder-gray-600 transition-colors focus:border-indigo-500 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={loading}
              className="min-h-11 rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50"
            >
              Send
            </button>
          </form>
        </footer>
      ) : null}
    </div>
  );
}
