// When the family adds a photo, Muse Spark looks at it and writes gentle
// reminiscence prompts, so the companion can talk about what's actually in it.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { hasMeta, config } from '../config.ts';
import { db } from '../db.ts';
import { chatJson } from '../meta.ts';
import { memoryItem } from '../domain.ts';
import { CONTENT_TYPES, mediaFile } from '../media.ts';
import { PHOTO_SYSTEM } from '../brain/prompts.ts';
import { toFamily } from '../events.ts';

export function offlinePrompts(kind: string, title: string, relationship: string): string[] {
  const first = title.split(/\s+/)[0];
  switch (kind) {
    case 'person':
      return [
        `What do you love most about ${first}?`,
        `What do you and ${first} like to do together?`,
        /grand|son|daughter|child|baby/i.test(relationship) ? `What was ${first} like as a little one?` : `What makes ${first} so special?`,
      ];
    case 'place':
      return [`What do you remember about ${title}?`, `Who was there with you at ${title}?`, `What was your favorite thing about ${title}?`];
    default:
      return [`What do you remember about this?`, `Who was there with you?`, `How did that day feel?`];
  }
}

export async function describePhoto(patientId: string, memoryId: string): Promise<void> {
  const item = memoryItem(patientId, memoryId);
  if (!item) return;
  let description = '';
  let prompts = offlinePrompts(item.kind, item.title, item.relationship);
  if (hasMeta() && item.photo_path && !item.photo_path.startsWith('/')) {
    const file = mediaFile(item.photo_path);
    const type = CONTENT_TYPES[extname(item.photo_path)] ?? 'image/jpeg';
    if (file && type.startsWith('image/') && type !== 'image/svg+xml') {
      try {
        const dataUrl = `data:${type};base64,${readFileSync(file).toString('base64')}`;
        const out = await chatJson<{ description: string; prompts: string[] }>({
          system: PHOTO_SYSTEM,
          model: config.meta.visionModel,
          user: [
            {
              type: 'text',
              text: `Family caption: "${item.title}"${item.relationship ? ` (${item.relationship})` : ''}. Notes: ${item.body || 'none'}.`,
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
          name: 'photo_prompts',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['description', 'prompts'],
            properties: { description: { type: 'string' }, prompts: { type: 'array', items: { type: 'string' } } },
          },
        });
        description = out.description.trim();
        if (out.prompts.length) prompts = out.prompts.slice(0, 4);
      } catch (e) {
        console.warn('[photos]', (e as Error).message);
      }
    }
  }
  db().run('UPDATE memory_items SET ai_description = ?, prompts_json = ? WHERE id = ?', description, JSON.stringify(prompts), memoryId);
  toFamily(patientId, { type: 'memory_updated', id: memoryId });
}
