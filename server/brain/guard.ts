// Reply guard. Every companion reply passes through here before it is spoken,
// whichever brain produced it. It enforces the lines we never cross.
import type { MemoryItem } from '../domain.ts';

export interface GuardContext {
  patientText: string | null;
  patientName: string;
  memory: MemoryItem[];
  deceasedPerson: MemoryItem | null;
  medicationQuestion: boolean;
}

export interface GuardResult {
  text: string;
  violations: string[];
}

const DEATH = /\b(died|dead|passed away|passed on|passing|no longer with us|not with us|isn'?t with us anymore|gone now|funeral|buried|grave|cemetery|death|widow(ed)?|lost (him|her|them))\b/i;
const SCOLDING = /[^.!?]*\b(already (asked|told|said|mentioned)|you asked (me )?(that|this)|as i (said|mentioned)|i just told you|like i said|don'?t you remember|you forgot|remember\? )[^.!?]*[.!?]?/gi;
const DOSING = /\b(\d+(\.\d+)?\s?(mg|milligrams?|ml|pills?|tablets?|capsules?)|take (another|an extra|two|one more|a second)|(stop|skip|double) (taking|your|the)|you (should|can|could) take)\b/i;
const IMPERSONATION = /\b(i('?m| am) (your|a) (daughter|son|husband|wife|grandson|granddaughter|sister|brother|mother|father|human|real person|person)|this is (sarah|your (daughter|son)))\b/i;
const MARKUP = /[*_#`>|~]|\p{Extended_Pictographic}/gu;

const MAX_SENTENCES = 3;

function firstName(title: string) {
  return title.split(/\s+/)[0];
}

export function guardReply(raw: string, ctx: GuardContext): GuardResult {
  const violations: string[] = [];
  let text = (raw ?? '').replace(MARKUP, '').replace(/\s+/g, ' ').trim();

  // 1. Never announce a death. If the person raises the loss themselves we
  //    don't block gentle acknowledgement, but we still never state it bluntly.
  const patientRaisedLoss = !!ctx.patientText && DEATH.test(ctx.patientText);
  const deceased = ctx.memory.filter((m) => m.kind === 'person' && m.deceased);
  const mentionsDeceased = deceased.some((d) => new RegExp(`\\b${firstName(d.title)}\\b`, 'i').test(text));
  if (DEATH.test(text) && (ctx.deceasedPerson || mentionsDeceased) && !patientRaisedLoss) {
    violations.push('death_announcement');
    const person = ctx.deceasedPerson ?? deceased.find((d) => new RegExp(`\\b${firstName(d.title)}\\b`, 'i').test(text))!;
    text = redirectForDeceased(person);
  }

  // 2. Never scold for repeating or forgetting.
  if (SCOLDING.test(text)) {
    violations.push('scolding');
    text = text.replace(SCOLDING, ' ').replace(/\s+/g, ' ').trim();
  }
  SCOLDING.lastIndex = 0;

  // 3. Never give dosing advice.
  if (DOSING.test(text) && (ctx.medicationQuestion || /\b(should|can|could) take\b/i.test(text))) {
    violations.push('medical_advice');
    text = `That's a really good question, ${ctx.patientName}. Your family and your doctor know best about your medicine, so I've made a note for them. Let's not take anything extra until they check.`;
  }

  // 4. Never pretend to be a person or a family member.
  if (IMPERSONATION.test(text)) {
    violations.push('impersonation');
    text = text.replace(IMPERSONATION, "I'm your companion");
  }

  // 5. Keep it short enough to follow.
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [text];
  if (sentences.length > MAX_SENTENCES) {
    violations.push('too_long');
    // Keep a trailing question if there is one: it hands the turn back to the person.
    const question = sentences.findLast((s) => s.trim().endsWith('?'));
    const head = sentences.slice(0, MAX_SENTENCES - (question ? 1 : 0));
    if (question && !head.includes(question)) head.push(question);
    text = head.join(' ').replace(/\s+/g, ' ').trim();
  }

  if (!text) {
    violations.push('empty');
    text = `I'm right here with you, ${ctx.patientName}.`;
  }
  return { text, violations };
}

/**
 * A gentle redirect that invites happy memories. Family-written notes about a
 * person often mention the death, so only conversation prompts that are free of
 * loss words are ever reused here.
 */
export function redirectForDeceased(person: MemoryItem): string {
  const name = firstName(person.title);
  let prompts: string[] = [];
  try {
    prompts = (JSON.parse(person.prompts_json) as string[]).filter((p) => !DEATH.test(p));
  } catch {
    // Malformed prompts just mean we use the generic question.
  }
  const question = prompts[0] ?? `What was ${name} like when you first met?`;
  return `You're thinking about ${name}. Tell me about ${name}. ${question}`;
}
