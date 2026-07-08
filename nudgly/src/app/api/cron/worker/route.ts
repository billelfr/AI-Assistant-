import { NextResponse } from "next/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { createClient as createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const REMINDER_TITLE = "🗓️ Upcoming Event Reminder";

interface CalendarEventRow {
  id?: string;
  user_id: string | null;
  title: string | null;
  start_time: string | null;
  end_time?: string | null;
  description?: string | null;
}

interface ExistingNotificationRow {
  id: string;
}

const getCronSupabaseClient = async () => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && serviceRoleKey) {
    return createSupabaseAdminClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return createServerSupabaseClient();
};

const formatEventStartTime = (startTime: string) => {
  const date = new Date(startTime);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
};

export async function GET() {
  try {
    const supabase = await getCronSupabaseClient();
    const now = new Date();
    const fifteenMinutesFromNow = new Date(Date.now() + 15 * 60 * 1000);

    const { data: events, error: eventsError } = await supabase
      .from("calendar_events")
      .select("id, user_id, title, start_time, end_time, description")
      .gte("start_time", now.toISOString())
      .lte("start_time", fifteenMinutesFromNow.toISOString());

    if (eventsError) {
      throw new Error(
        `Failed to query upcoming calendar events: ${eventsError.message}`,
      );
    }

    let processed = 0;

    for (const event of (events || []) as CalendarEventRow[]) {
      const formattedStartTime = event.start_time
        ? formatEventStartTime(event.start_time)
        : null;
      const title = event.title?.trim() || "Untitled event";

      if (!event.user_id || !formattedStartTime) {
        console.warn("Skipping malformed calendar event reminder:", event);
        continue;
      }

      const body = `"${title}" is scheduled to begin shortly at ${formattedStartTime}!`;

      const { data: existingNotification, error: duplicateError } =
        await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", event.user_id)
          .eq("title", REMINDER_TITLE)
          .eq("body", body)
          .limit(1)
          .maybeSingle<ExistingNotificationRow>();

      if (duplicateError) {
        throw new Error(
          `Failed to check duplicate notification for event ${event.id || title}: ${duplicateError.message}`,
        );
      }

      if (existingNotification) {
        continue;
      }

      const { error: insertError } = await supabase
        .from("notifications")
        .insert({
          user_id: event.user_id,
          title: REMINDER_TITLE,
          body,
        });

      if (insertError) {
        throw new Error(
          `Failed to create notification for event ${event.id || title}: ${insertError.message}`,
        );
      }

      processed += 1;
    }

    return NextResponse.json({ processed });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown cron worker error.";

    console.error("Cron worker error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
