// DOM helpers for the X Articles list page (isolated world).
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CREATE_LABELS = ['create', 'write', 'compose', 'new article', '撰写', '創作', '撰寫', '创建', '建立', '新建', '作成', '新規作成', '작성', 'crear', 'créer', 'erstellen'];
const FORBIDDEN = /publish|发布|發佈|發布|公開|게시|post/i;

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The "create article" button on /compose/articles (aria-label "create" or a localized label). */
export function findCreateButton(root: ParentNode = document): HTMLElement | null {
  const buttons = [...root.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"]')];
  const label = (b: HTMLElement) => norm(b.getAttribute('aria-label'));
  const byAria = buttons.find((b) => label(b) === 'create') ?? buttons.find((b) => CREATE_LABELS.includes(label(b)));
  if (byAria) return byAria;
  const empty = root.querySelector('[data-testid="empty_state_button_text"]')?.closest<HTMLElement>('button, a, [role="button"]');
  if (empty && !FORBIDDEN.test(norm(empty.textContent))) return empty;
  return buttons.find((b) => CREATE_LABELS.includes(norm(b.textContent)) && !FORBIDDEN.test(label(b))) ?? null;
}

/** Clicks "create" on the Articles list and waits for /compose/articles/edit/<id>. */
export async function clickCreate(timeoutMs = 20_000): Promise<string> {
  if (!/\/compose\/articles\/?$/.test(location.pathname)) throw new Error('当前页面不是 X 文章列表');
  const deadline = Date.now() + timeoutMs;
  let clicked = false;
  while (Date.now() < deadline) {
    const id = /\/compose\/articles\/edit\/(\d+)/.exec(location.pathname)?.[1];
    if (id) return id;
    if (!clicked) {
      const button = findCreateButton();
      if (button) {
        button.click();
        clicked = true;
      }
    }
    await sleep(250);
  }
  throw new Error(clicked ? '新建草稿超时' : '未找到 X 文章的新建按钮');
}
