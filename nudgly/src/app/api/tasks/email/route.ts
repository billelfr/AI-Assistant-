import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { createClient } from "@/lib/supabase/server";

interface TaskPayload {
    id?: string;
    title?: string;
    description?: string | null;
    status?: string | null;
    due_at?: string | null;
}

const formatTaskStatus = (status?: string | null) =>
    status ? status.replace(/_/g, " ") : "pending";

const buildTasksEmailContent = (tasks: TaskPayload[]) => {
    const lines = ["Here are your tasks from Nudgly:", ""];

    tasks.forEach((task, index) => {
        const details = [`${index + 1}. ${task.title || "Untitled task"}`];

        if (task.description) {
            details.push(`- ${task.description}`);
        }

        if (task.due_at) {
            details.push(`- Due ${new Date(task.due_at).toLocaleString()}`);
        }

        if (task.status) {
            details.push(`- Status: ${formatTaskStatus(task.status)}`);
        }

        lines.push(details.join("\n"));
    });

    return lines.join("\n");
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

        const body = (await request.json().catch(() => null)) as
            | { tasks?: TaskPayload[] }
            | null;
        const tasks = Array.isArray(body?.tasks) ? body.tasks : [];

        if (!tasks.length) {
            return NextResponse.json(
                { error: "No tasks were provided to send." },
                { status: 400 },
            );
        }

        const recipient = user.email?.trim();
        if (!recipient) {
            return NextResponse.json(
                { error: "No email address is available for this account." },
                { status: 400 },
            );
        }

        const host = process.env.SMTP_HOST || process.env.GMAIL_SMTP_HOST;
        const port = Number(process.env.SMTP_PORT || process.env.GMAIL_SMTP_PORT || 587);
        const userName = process.env.SMTP_USER || process.env.GMAIL_USER;
        const password = process.env.SMTP_PASS || process.env.GMAIL_PASS;

        if (!host || !userName || !password) {
            return NextResponse.json(
                {
                    error:
                        "Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in your environment.",
                },
                { status: 500 },
            );
        }

        const transporter = nodemailer.createTransport({
            host,
            port,
            secure: port === 465,
            auth: {
                user: userName,
                pass: password,
            },
        });

        const subject = "Your tasks from Nudgly";
        const text = buildTasksEmailContent(tasks);

        await transporter.sendMail({
            from: userName,
            to: recipient,
            subject,
            text,
            html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${text}</pre>`,
        });

        return NextResponse.json({ success: true, recipient });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unable to send email.";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
