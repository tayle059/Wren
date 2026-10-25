// Password rules: long enough, not common, not just your own name or email.

const COMMON = new Set(
  `password password1 password123 123456 1234567 12345678 123456789 1234567890 qwerty qwerty123 qwertyuiop abc123 111111
  000000 iloveyou admin welcome welcome1 letmein monkey dragon sunshine princess football baseball shadow master
  superman trustno1 passw0rd starwars whatever freedom michael jennifer hunter2 1q2w3e4r 1qaz2wsx zaq12wsx
  changeme secret login access flower hello123 loveme lovely charlie donald mustang batman computer internet
  summer2024 summer2025 summer2026 winter2025 winter2026 spring2026 autumn2026 kindred kindred123 dementia family123
  grandma grandpa mommy123 daddy123 abcdef abcdefg abcdefgh 987654321 asdfghjkl zxcvbnm`.split(/\s+/),
);

export interface PasswordCheck {
  ok: boolean;
  score: 0 | 1 | 2 | 3 | 4;
  problems: string[];
}

export function checkPassword(password: string, context: { email?: string; name?: string } = {}): PasswordCheck {
  const problems: string[] = [];
  const lower = password.toLowerCase();
  if (password.length < 10) problems.push('Use at least 10 characters.');
  if (password.length > 200) problems.push('That password is too long.');
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9]/g, ''))) problems.push('That password is too common.');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && lower.includes(local)) problems.push('Don’t include your email address.');
  for (const part of (context.name ?? '').toLowerCase().split(/\s+/)) {
    // "sarah2024!" is just a name plus decoration.
    if (part.length >= 3 && lower.includes(part) && lower.replace(part, '').replace(/[^a-z]/g, '').length < 3) {
      problems.push('Don’t base it only on your name.');
      break;
    }
  }
  if (/^(.)\1+$/.test(password)) problems.push('Avoid repeating one character.');

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const lengthScore = password.length >= 16 ? 2 : password.length >= 12 ? 1 : 0;
  let score = Math.min(4, lengthScore + Math.max(0, classes - 1)) as PasswordCheck['score'];
  if (problems.length) score = Math.min(score, 1) as PasswordCheck['score'];
  return { ok: problems.length === 0, score, problems };
}
