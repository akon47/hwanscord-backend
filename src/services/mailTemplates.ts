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
  greetingName: string;
  lines: string[];
  buttonLabel: string;
  url: string;
  expiry: string;
}

/** Table-based, inline-styled layout: renders in Gmail, Naver Mail and mobile clients. */
function render(layout: Layout): { html: string; text: string } {
  const name = escapeHtml(layout.greetingName);
  const url = escapeHtml(layout.url);
  const paragraphs = layout.lines
    .map(
      (l) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#313338;">${escapeHtml(l)}</p>`,
    )
    .join('');
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
<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#313338;">${name}님, 안녕하세요.</p>
${paragraphs}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="border-radius:8px;background:${BRAND};">
<a href="${url}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(layout.buttonLabel)}</a>
</td></tr></table>
<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#5c5e66;">이 링크는 ${escapeHtml(layout.expiry)} 동안 한 번만 쓸 수 있어요.</p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#5c5e66;">버튼이 열리지 않으면 아래 주소를 브라우저에 붙여 넣으세요.</p>
<p style="margin:0 0 20px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${url}" style="color:${BRAND};">${url}</a></p>
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
    `${layout.greetingName}님, 안녕하세요.`,
    ...layout.lines,
    '',
    `${layout.buttonLabel}: ${layout.url}`,
    `이 링크는 ${layout.expiry} 동안 한 번만 쓸 수 있어요.`,
    '',
    '본인이 요청하지 않았다면 이 메일은 무시하세요. 계정에는 아무 변화도 생기지 않아요.',
  ].join('\n');
  return { html, text };
}

export function verifyMail(to: string, displayName: string, url: string): MailMessage {
  return {
    to,
    subject: '[HWANSCORD] 이메일 주소를 인증해 주세요',
    ...render({
      title: '이메일 주소 인증',
      greetingName: displayName,
      lines: [
        'HWANSCORD 계정에 이 이메일 주소를 등록했어요.',
        '아래 버튼을 누르면 인증이 끝나고, 비밀번호를 잊었을 때 이 주소로 복구할 수 있어요.',
      ],
      buttonLabel: '이메일 인증하기',
      url,
      expiry: '24시간',
    }),
  };
}

export function changeMail(to: string, displayName: string, url: string): MailMessage {
  return {
    to,
    subject: '[HWANSCORD] 새 이메일 주소를 확인해 주세요',
    ...render({
      title: '이메일 주소 변경 확인',
      greetingName: displayName,
      lines: [
        'HWANSCORD 계정의 이메일을 이 주소로 바꾸려는 요청이 있었어요.',
        '아래 버튼을 눌러야 변경이 완료돼요.',
      ],
      buttonLabel: '이 주소로 변경하기',
      url,
      expiry: '24시간',
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
      buttonLabel: '비밀번호 재설정하기',
      url,
      expiry: '30분',
    }),
  };
}
