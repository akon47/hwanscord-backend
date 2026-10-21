import type { MailMessage } from './mailer.js';

const BRAND = '#5865f2';
const LOGO = 'https://hwanscord.kimhwan.kr/icon-192.png';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Layout {
  title: string;
  /** null → no personal greeting (signup: there is no account yet) */
  greetingName: string | null;
  lines: string[];
  /** a 6-digit code shown large, or a button with a link */
  code?: string;
  buttons?: { label: string; url: string }[];
  /** e.g. "10분 동안 한 번만" */
  validity?: string;
}

const P = 'margin:0 0 14px;font-size:15px;line-height:1.6;color:#313338;';
const SMALL = 'margin:0 0 8px;font-size:13px;line-height:1.6;color:#5c5e66;';

/** Table-based, inline-styled layout: renders in Gmail, Naver Mail and mobile clients. */
function render(layout: Layout): { html: string; text: string } {
  const greeting = layout.greetingName
    ? `<p style="${P}">${escapeHtml(layout.greetingName)}님, 안녕하세요.</p>`
    : `<p style="${P}">안녕하세요.</p>`;
  const paragraphs = layout.lines.map((l) => `<p style="${P}">${escapeHtml(l)}</p>`).join('');
  const code = layout.code
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr>
<td style="padding:14px 22px;border-radius:10px;background:#f2f3f5;border:1px solid #e3e5e8;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:32px;font-weight:800;letter-spacing:10px;color:#060607;">${escapeHtml(layout.code)}</td>
</tr></table>`
    : '';
  const buttons = (layout.buttons ?? [])
    .map(
      (b, i) =>
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:${i === 0 ? '22px' : '10px'} 0 0;"><tr><td style="border-radius:8px;background:${i === 0 ? BRAND : '#4e5058'};">
<a href="${escapeHtml(b.url)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(b.label)}</a>
</td></tr></table>`,
    )
    .join('');
  const validity = layout.validity
    ? `<p style="${SMALL}margin-top:18px;">이 ${layout.code ? '코드' : '링크'}는 ${escapeHtml(layout.validity)} 쓸 수 있어요.</p>`
    : '';
  const fallback =
    layout.buttons && layout.buttons.length > 0
      ? `<p style="${SMALL}">버튼이 열리지 않으면 아래 주소를 브라우저에 붙여 넣으세요.</p>
<p style="margin:0 0 20px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${escapeHtml(layout.buttons[0]!.url)}" style="color:${BRAND};">${escapeHtml(layout.buttons[0]!.url)}</a></p>`
      : '';
  const html = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(layout.title)}</title></head>
<body style="margin:0;padding:0;background:#f2f3f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif;">
<tr><td style="background:${BRAND};padding:20px 24px;">
<img src="${LOGO}" width="36" height="36" alt="" style="vertical-align:middle;border-radius:8px;">
<span style="vertical-align:middle;margin-left:10px;font-size:18px;font-weight:800;color:#ffffff;letter-spacing:.5px;">HWANSCORD</span>
</td></tr>
<tr><td style="padding:28px 24px 8px;">
<h1 style="margin:0 0 16px;font-size:20px;color:#060607;">${escapeHtml(layout.title)}</h1>
${greeting}
${paragraphs}
${code}${buttons}
${validity}
${fallback}
</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #ebedef;font-size:12px;line-height:1.6;color:#80848e;">
본인이 요청하지 않았다면 이 메일은 무시하세요. 계정에는 아무 변화도 생기지 않아요.<br>HWANSCORD · hwanscord.kimhwan.kr
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  const text = [
    `[HWANSCORD] ${layout.title}`,
    '',
    layout.greetingName ? `${layout.greetingName}님, 안녕하세요.` : '안녕하세요.',
    ...layout.lines,
    '',
    ...(layout.code ? [`인증 코드: ${layout.code}`] : []),
    ...(layout.buttons ?? []).map((b) => `${b.label}: ${b.url}`),
    ...(layout.validity ? [`이 ${layout.code ? '코드' : '링크'}는 ${layout.validity} 쓸 수 있어요.`] : []),
    '',
    '본인이 요청하지 않았다면 이 메일은 무시하세요. 계정에는 아무 변화도 생기지 않아요.',
  ].join('\n');
  return { html, text };
}

export function signupCodeMail(to: string, code: string): MailMessage {
  return {
    to,
    subject: `[HWANSCORD] 인증 코드 ${code}`,
    ...render({
      title: '가입 인증 코드',
      greetingName: null,
      lines: [
        'HWANSCORD 가입을 위해 이 이메일 주소를 확인하고 있어요.',
        '아래 6자리 코드를 가입 화면에 입력해 주세요.',
      ],
      code,
      validity: '10분 동안 한 번만',
    }),
  };
}

export function changeCodeMail(to: string, displayName: string, code: string): MailMessage {
  return {
    to,
    subject: `[HWANSCORD] 이메일 인증 코드 ${code}`,
    ...render({
      title: '이메일 인증 코드',
      greetingName: displayName,
      lines: [
        'HWANSCORD 계정에 이 이메일 주소를 등록하려고 해요.',
        '아래 6자리 코드를 입력하면 등록이 끝나요.',
      ],
      code,
      validity: '10분 동안 한 번만',
    }),
  };
}

/** Sent instead of a code when someone starts signing up with an address that already has an account. */
export function alreadyRegisteredMail(to: string, loginUrl: string, resetUrl: string): MailMessage {
  return {
    to,
    subject: '[HWANSCORD] 이미 가입된 이메일입니다',
    ...render({
      title: '이미 가입된 이메일입니다',
      greetingName: null,
      lines: [
        '이 이메일 주소로 HWANSCORD 가입이 시도되었지만, 이 주소는 이미 계정에 등록되어 있어요.',
        '로그인하거나, 비밀번호가 기억나지 않으면 비밀번호를 재설정하세요.',
      ],
      buttons: [
        { label: '로그인하기', url: loginUrl },
        { label: '비밀번호 재설정', url: resetUrl },
      ],
    }),
  };
}

export function resetMail(to: string, displayName: string, url: string): MailMessage {
  return {
    to,
    subject: '[HWANSCORD] 비밀번호 재설정',
    ...render({
      title: '비밀번호 재설정',
      greetingName: displayName,
      lines: [
        '비밀번호 재설정 요청을 받았어요.',
        '아래 버튼을 눌러 새 비밀번호를 정해 주세요. 재설정하면 다른 기기의 로그인은 모두 해제돼요.',
      ],
      buttons: [{ label: '비밀번호 재설정하기', url }],
      validity: '30분 동안 한 번만',
    }),
  };
}
