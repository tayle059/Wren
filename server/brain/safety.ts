// Deterministic safety net. Runs on every utterance BEFORE the language model,
// so an emergency alert never depends on a model call succeeding.
import type { MemoryItem } from '../domain.ts';

export interface Concern {
  level: 'urgent' | 'fyi';
  category: string;
  reason: string;
}

export interface SafetyAssessment {
  emergency: (Concern & { guidance: string }) | null;
  concerns: Concern[];
  exitSeeking: boolean;
  deceasedPerson: MemoryItem | null;
  medicationQuestion: boolean;
  distress: boolean;
  joy: boolean;
}

const NEGATION = /\b(didn'?t|did not|never|haven'?t|have not|wasn'?t|not|no)\s+(\w+\s+){0,2}$/;

/** True if `re` matches somewhere not directly preceded by a negation ("I didn't fall"). */
function affirmed(text: string, re: RegExp): RegExpMatchArray | null {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of text.matchAll(global)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 30), m.index);
    if (!NEGATION.test(before)) return m;
  }
  return null;
}

interface Rule {
  category: string;
  re: RegExp;
  reason: (name: string, quote: string) => string;
  guidance: string;
}

const EMERGENCIES: Rule[] = [
  {
    category: 'self_harm',
    re: /\b(want to die|wanna die|kill myself|end it all|don'?t want to (live|be here)( anymore)?|better off dead|end my life)\b/i,
    reason: (n, q) => `${n} said something that sounds like not wanting to live ("${q}"). Please call right now.`,
    guidance:
      'The person may be expressing thoughts of not wanting to live. Respond with deep warmth: they matter and are loved, their family is being told right now, and you are staying with them. Do not change the subject or minimize it.',
  },
  {
    category: 'fall',
    re: /\b(i|i'?ve|i have|i just|i think i)\s+(just\s+)?(fell|fallen|tripped|slipped)(?!\s+asleep)\b|\b(fell|fall(en)?) (down|over|on the floor)\b|\bon the floor\b|\bcan'?t get up\b|\bcannot get up\b/i,
    reason: (n, q) => `${n} may have fallen ("${q}").`,
    guidance:
      'The person may have fallen. Stay calm and reassuring. Say you have let their family know right away (never promise that anyone is on the way). Ask them to stay still and comfortable rather than rush to get up. Ask gently where it hurts.',
  },
  {
    category: 'medical',
    re: /\b(chest (pain|hurts|feels tight|is tight)|my chest|can'?t breathe|hard to breathe|trouble breathing|short of breath|heart attack|can'?t (move|feel) my (arm|leg|face)|face (feels )?numb|bleeding|lots of blood|i'?m bleeding)\b/i,
    reason: (n, q) => `${n} described a possible medical emergency ("${q}"). Consider calling right away or calling emergency services.`,
    guidance:
      'This may be a medical emergency. Stay calm. Say you have let their family know right away. If they can, they should sit down and rest. Keep sentences very short. Do not give medical advice.',
  },
  {
    category: 'safety',
    re: /\b(someone'?s? (is )?in (the|my) house|there'?s (a|some) (man|woman|stranger|person) (in|at|outside)|a stranger|someone'?s? (is )?(breaking|trying to get) in|i smell gas|something'?s? (is )?burning|there'?s (a )?fire|smoke (in|everywhere))\b/i,
    reason: (n, q) => `${n} may be unsafe at home ("${q}").`,
    guidance:
      'The person may feel unsafe or there may be a hazard. Stay calm. Say you have let their family know right now. Suggest they stay where they feel safe.',
  },
  {
    category: 'help',
    re: /^\s*(please\s+)?help(\s+me)?\s*[.!]*\s*$|\b(somebody|someone) help\b|\bcall (911|an ambulance|the police|for help)\b|\bi need (a doctor|an ambulance)\b|\bit'?s an emergency\b/i,
    reason: (n, q) => `${n} asked for help ("${q}").`,
    guidance: 'The person is asking for help. Stay calm, say you have let their family know, and ask gently what is happening.',
  },
];

const EXIT_SEEKING =
  /\b(i (need|have|want|got|ought) to (go|get) (home|to work|back home|out of here)|i want to go home|take me home|i'?m going home|let me go home|where'?s my (car|coat|purse|keys)|(go|get|pick up) the (kids|children)|(leave|get out of) (the|this) house|i'?m late for work)\b/i;

const MEDICATION =
  /\b((should|can|do|must) i take|how many (pills|tablets)|double (dose|up)|took (my )?(pills?|medicine|meds|medication) (twice|again|already)|extra (pill|dose|tablet)|skip my (pill|medicine|meds))\b/i;

const MED_DOUBLE = /\btook (my )?(pills?|medicine|meds|medication) (twice|again)\b|\bdouble (dose|up)\b|\bextra (pill|dose|tablet)\b/i;

const DISTRESS =
  /\b(scared|afraid|frightened|terrified|worried|anxious|lonely|so alone|all alone|sad|confused|i'?m lost|don'?t know where i am|upset|crying|nervous|panic|something'?s wrong)\b/i;

const JOY = /\b(love(ly)?|wonderful|happy|beautiful|delightful|so nice|that'?s nice|haha|ha ha|laugh(ed|ing)?|fun|grand|marvelous)\b/i;

const DECEASED_CUE = /\b(where('?s| is| did)|coming|come home|home yet|seen|see him|see her|call|phone|ring|miss|when will|waiting for|back from|is .* (here|okay|alive))\b/i;

function firstName(title: string) {
  return title.split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '');
}

export function assessSafety(text: string, patientName: string, memory: MemoryItem[], companionName = 'The companion'): SafetyAssessment {
  const quote = text.trim().slice(0, 160);
  const out: SafetyAssessment = {
    emergency: null,
    concerns: [],
    exitSeeking: false,
    deceasedPerson: null,
    medicationQuestion: false,
    distress: false,
    joy: false,
  };

  for (const rule of EMERGENCIES) {
    if (affirmed(text, rule.re)) {
      out.emergency = { level: 'urgent', category: rule.category, reason: rule.reason(patientName, quote), guidance: rule.guidance };
      out.concerns.push(out.emergency);
      break;
    }
  }

  if (EXIT_SEEKING.test(text)) {
    out.exitSeeking = true;
    out.concerns.push({
      level: 'fyi',
      category: 'exit_seeking',
      reason: `${patientName} talked about needing to leave ("${quote}"). ${companionName} redirected gently.`,
    });
  }

  if (MEDICATION.test(text)) {
    out.medicationQuestion = true;
    if (MED_DOUBLE.test(text)) {
      out.concerns.push({
        level: 'urgent',
        category: 'medication',
        reason: `${patientName} may have taken extra medication ("${quote}"). Please check the pill organizer.`,
      });
    } else {
      out.concerns.push({ level: 'fyi', category: 'medication_question', reason: `${patientName} asked about medication ("${quote}").` });
    }
  }

  for (const item of memory) {
    if (item.kind !== 'person' || !item.deceased) continue;
    const name = firstName(item.title);
    if (name.length < 2) continue;
    const mentions = new RegExp(`\\b${name}\\b`, 'i').test(text);
    if (mentions && DECEASED_CUE.test(text)) {
      out.deceasedPerson = item;
      out.concerns.push({
        level: 'fyi',
        category: 'asked_for_deceased',
        reason: `${patientName} asked for ${item.title} (${item.relationship || 'who has passed away'}). ${companionName} talked about happy memories of ${name} and did not mention the loss.`,
      });
      break;
    }
  }

  out.distress = !!out.emergency || DISTRESS.test(text);
  out.joy = !out.distress && JOY.test(text);
  return out;
}
