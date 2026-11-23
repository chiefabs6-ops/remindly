---
name: meeting
description: Summarise a Google Meet meeting captured by Tether and send the user's own action items for approval. Use when the user runs /tether:meeting <meetingId> or asks Claude to summarise a Tether meeting.
---

# Summarise a Tether meeting

Running this sends the meeting transcript to Claude (Anthropic). The user chose that by running the command.

1. Take the meeting id from the user's request (`/tether:meeting <meetingId>`). If there is none, ask for it.
2. Call `tether_get_meeting` with `meetingId`. Note the meeting's start date.
3. Write a summary of 3-6 sentences: what the meeting was about and what came out of it.
4. List the decisions that were made (short sentences). Leave the list empty if there were none.
5. List the user's own action items, and only those:
   - "You" in the transcript is the user. Include what "You" committed to, and what someone asked of "You".
   - Never include other people's tasks.
   - `title`: a short imperative action. `quote`: the transcript line it came from.
   - `dueDate` (YYYY-MM-DD) only if a time was said. Resolve "Friday" or "next week" against the meeting's start date, not today.
6. Call `tether_save_meeting_summary` with `meetingId`, `summary`, `decisions` and `actionItems`.
7. Tell the user, in one or two lines, that the summary is in the meeting note and how many action item
   suggestions are waiting for approval in Tether (use the count the tool returns).
