import fs from 'fs';
import path from 'path';
import { config } from '../config';

interface ClickUpTask {
  id: string;
  name: string;
  url: string;
}

export class ClickUpService {
  private readonly apiToken: string;
  private readonly listId: string;
  private readonly baseUrl = 'https://api.clickup.com/api/v2';

  constructor() {
    this.apiToken = config.clickupApiToken;
    this.listId = config.clickupListId;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: this.apiToken,
      'Content-Type': 'application/json',
    };
  }

  get isConfigured(): boolean {
    return !!this.apiToken && !!this.listId;
  }

  // ── Create a task in the configured list ──────────────────────────
  async createTask(name: string, description: string): Promise<ClickUpTask> {
    const res = await fetch(`${this.baseUrl}/list/${this.listId}/task`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        name,
        description,
        status: 'to do',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ClickUp create task error: ${res.status} — ${text}`);
    }

    const data = await res.json() as { id: string; name: string; url: string };
    console.log(`ClickUp task created: ${data.id} — ${data.url}`);
    return { id: data.id, name: data.name, url: data.url };
  }

  // ── Upload a file attachment to an existing task ──────────────────
  async uploadAttachment(taskId: string, filePath: string, fileName: string): Promise<string> {
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'audio/mp4' });

    const formData = new FormData();
    formData.append('attachment', blob, fileName);

    const res = await fetch(`${this.baseUrl}/task/${taskId}/attachment`, {
      method: 'POST',
      headers: {
        Authorization: this.apiToken,
        // No Content-Type — let fetch set multipart boundary
      },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ClickUp upload error: ${res.status} — ${text}`);
    }

    const data = await res.json() as { url?: string };
    console.log(`ClickUp attachment uploaded to task ${taskId}`);
    return data.url || '';
  }

  // ── Full flow: create task + upload audio ─────────────────────────
  async createTaskWithAudio(
    meetingTitle: string,
    summaryText: string,
    audioFilePath: string,
  ): Promise<{ taskUrl: string; taskId: string }> {
    if (!this.isConfigured) {
      throw new Error('ClickUp not configured — set CLICKUP_API_TOKEN and CLICKUP_LIST_ID');
    }

    const fileName = `${meetingTitle.replace(/[^a-zA-Z0-9\s-]/g, '').trim()}.mp4`;

    // 1. Create the task
    const task = await this.createTask(meetingTitle, summaryText);

    // 2. Upload audio attachment
    await this.uploadAttachment(task.id, audioFilePath, fileName);

    return { taskUrl: task.url, taskId: task.id };
  }
}
