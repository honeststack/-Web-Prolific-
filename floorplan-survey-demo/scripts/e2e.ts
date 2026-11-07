/**
 * Browser check of the running site, through the real UI.
 *   npm run e2e -- http://localhost:8787 [screenshot-dir]
 * A fresh, empty data store is expected. Exits non-zero if any check fails.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, Page } from "playwright";
import { parseCsv } from "./lib/validate";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const shots = process.argv[3] ?? ".e2e";
mkdirSync(shots, { recursive: true });
const failures: string[] = [];
let checks = 0;

function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const browser = await chromium.launch();
const consoleProblems: string[] = [];

async function newPage(width = 1440, height = 900, opts: { expectFailedRequests?: boolean } = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => consoleProblems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !opts.expectFailedRequests) consoleProblems.push(`http ${r.status()}: ${r.request().method()} ${r.url()} ${r.request().postData() ?? ""}`);
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (opts.expectFailedRequests && /404|400|ERR_|Failed to load/.test(m.text())) return;
    consoleProblems.push(`console: ${m.text()}`);
  });
  return page;
}
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: join(shots, `${name}.png`), fullPage });
const url = (pid: string, extra = "") => `${base}/?PROLIFIC_PID=${pid}&STUDY_ID=STUDY1&SESSION_ID=SES_${pid}${extra}`;
const clickChoice = (page: Page, text: string) => page.locator("label.choice", { hasText: text }).first().click();
const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });

async function noOverflow(page: Page, name: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${name}: no horizontal scroll`, over <= 0, `overflow ${over}px`);
}

async function waitForPlans(page: Page) {
  await page.waitForSelector(".stage.is-ready");
}

async function planBoxes(page: Page) {
  return page.$$eval(".plan-frame img", (images) =>
    (images as HTMLImageElement[]).map((img) => {
      const box = img.getBoundingClientRect();
      return { w: Math.round(box.width), h: Math.round(box.height), nw: img.naturalWidth, nh: img.naturalHeight, fit: getComputedStyle(img).objectFit, bottom: box.bottom };
    }),
  );
}

async function passIntro(page: Page) {
  await button(page, "I agree and continue").click();
  await button(page, "Continue").click();
  await clickChoice(page, "Which floor plan is more similar to A.");
  await button(page, "Submit answer").click();
}

async function answerCurrent(page: Page, choice?: string) {
  await waitForPlans(page);
  const title = await page.locator(".band-title").innerText();
  const prompt = (await page.locator(".prompt").count()) ? await page.locator(".prompt").innerText() : "";
  const instructed = /select “Floor plan ([BC])”/.exec(prompt)?.[1];
  await clickChoice(page, choice ?? (instructed ? `Floor plan ${instructed}.` : "Floor plan B."));
  await button(page, "Continue").click();
  await page.waitForFunction((previous) => document.querySelector(".band-title")?.textContent !== previous, title);
}

console.log("\nHub");
{
  const page = await newPage();
  await page.goto(base);
  await page.waitForSelector(".tour");
  await shot(page, "01-hub", true);
  await noOverflow(page, "hub");
  await page.close();
}

console.log("\nMissing Prolific parameters");
{
  const page = await newPage();
  await page.goto(`${base}/?PROLIFIC_PID=ONLYPID`);
  await page.waitForSelector("text=missing required information");
  check("incomplete URL is refused with a message", true);
  await page.close();
}

console.log("\nComprehension branch");
{
  const page = await newPage();
  await page.goto(url("FAILER"));
  await button(page, "I agree and continue").waitFor();
  await shot(page, "02-consent");
  await button(page, "I agree and continue").click();
  await button(page, "Continue").waitFor();
  await shot(page, "03-instructions");
  await button(page, "Continue").click();
  check("submit disabled before answering", await button(page, "Submit answer").isDisabled());
  await shot(page, "04-comprehension");
  await clickChoice(page, "Which apartment I would prefer");
  await button(page, "Submit answer").click();
  await page.waitForSelector("text=second attempt");
  await shot(page, "05-comprehension-retry");
  await clickChoice(page, "more expensive");
  await button(page, "Submit answer").click();
  await page.waitForSelector("text=End of study — comprehension check");
  await shot(page, "06-comprehension-end");
  await page.goto(url("FAILER"));
  await page.waitForSelector("text=End of study — comprehension check");
  check("failed participant cannot retake on re-entry", true);
  await page.close();
}

console.log("\nDecline");
{
  const page = await newPage();
  await page.goto(url("DECLINER"));
  await button(page, "I do not agree").click();
  await page.waitForSelector("text=You chose not to take part");
  await shot(page, "07-declined");
  check("decline shows the end screen", true);
  await page.close();
}

console.log("\nFull participant run through the UI (42 questions)");
const seen: string[] = [];
{
  const page = await newPage();
  await page.goto(url("FULLRUN"));
  await page.waitForSelector("text=Study information");
  await passIntro(page);
  await waitForPlans(page);
  await shot(page, "08-practice");
  check("practice is labelled", (await page.locator(".band-title").innerText()).startsWith("Practice"));
  await answerCurrent(page);
  await answerCurrent(page);

  await waitForPlans(page);
  check("first question shows 1 / 42", (await page.locator(".band-title").innerText()).trim() === "Question 1 / 42");
  check("continue disabled until an answer is chosen", await button(page, "Continue").isDisabled());
  const boxes = await planBoxes(page);
  check("three plans at the same size", boxes.length === 3 && new Set(boxes.map((b) => `${b.w}x${b.h}`)).size === 1, JSON.stringify(boxes));
  check("aspect ratio kept without cropping", boxes.every((b) => b.fit === "contain"));
  check("all plans fit the viewport", boxes.every((b) => b.bottom <= 900));
  await noOverflow(page, "trial 1440x900");
  await shot(page, "09-question");

  await page.locator(".plan-frame").nth(1).click();
  await page.waitForSelector(".lightbox");
  await shot(page, "10-lightbox-single");
  await page.getByRole("tab", { name: "All three" }).click();
  await shot(page, "11-lightbox-all");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".lightbox", { state: "detached" });
  check("enlarged view opens and closes", true);

  for (let q = 1; q <= 42; q++) {
    await waitForPlans(page);
    const title = (await page.locator(".band-title").innerText()).trim();
    check(`question counter ${q}`, title === `Question ${q} / 42`, title);
    const prompt = await page.locator(".prompt").innerText();
    if (q === 16 || q === 31) {
      check(`question ${q} is the attention check`, prompt.includes(q === 16 ? "Floor plan B" : "Floor plan C"), prompt);
      if (q === 31) await shot(page, "12-attention");
    } else {
      check(`question ${q} is a normal trial`, prompt === "Which floor plan is more similar to A?", prompt);
    }
    seen.push(await page.locator(".plan-reference img").getAttribute("src").then((s) => s ?? ""));
    await answerCurrent(page, q === 3 ? "Both are equally similar." : q === 4 ? "I cannot judge" : undefined);
    if (q === 42) await page.waitForSelector("text=About your judgement");
  }

  check("continue blocked on aspects until one is selected", await button(page, "Continue").isDisabled());
  await clickChoice(page, "Room sizes");
  await clickChoice(page, "Number of rooms");
  await clickChoice(page, "Other");
  check("Other requires a description", await button(page, "Continue").isDisabled());
  await page.getByLabel("Describe other aspect").fill("Balcony position");
  await shot(page, "13-aspects", true);
  await button(page, "Continue").click();
  await page.waitForSelector("text=Most important aspect");
  check("most-important lists only what was selected", (await page.locator("label.choice").count()) === 3);
  await clickChoice(page, "Other");
  check("Other text carried over", (await page.getByLabel("Describe other aspect").inputValue()) === "Balcony position");
  await shot(page, "14-most");
  await button(page, "Continue").click();
  await page.waitForSelector("text=Overall difficulty");
  await clickChoice(page, "3 — Neither");
  await shot(page, "15-difficulty");
  await button(page, "Continue").click();
  await page.waitForSelector("text=Additional comments");
  await page.locator("textarea").fill('Comma, "quote" and\nnew line');
  await shot(page, "16-comments");
  await button(page, "Continue").click();
  await page.waitForSelector("text=About you");
  check("submit disabled until demographics are complete", await button(page, "Submit survey").isDisabled());
  const demographicAnswers = ["25 – 34", "Prefer not to say", "Master's degree", "No, neither", "4–5", "3 — Moderately familiar"];
  for (const [index, answer] of demographicAnswers.entries()) {
    await page.locator("fieldset").nth(index).locator("label.choice", { hasText: answer }).click();
  }
  await shot(page, "17-demographics", true);
  await button(page, "Submit survey").click();
  await page.waitForSelector("text=Your survey responses have been saved.");
  await shot(page, "18-complete");
  await page.waitForURL(/completion-preview\?cc=DEMO1234/, { timeout: 15000 });
  check("redirects to the completion URL after saving", true);
  await shot(page, "19-completion-preview");

  await page.goto(url("FULLRUN"));
  await page.waitForSelector("text=You have already completed this study.");
  check("completed participant cannot answer again", (await page.locator("label.choice").count()) === 0);
  await shot(page, "20-already-completed");
  await page.close();
}

console.log("\nDropout: browser back and re-entry");
{
  const page = await newPage();
  await page.goto(url("BACKER"));
  await page.waitForSelector("text=Study information");
  await passIntro(page);
  await answerCurrent(page);
  await answerCurrent(page);
  await answerCurrent(page);
  await answerCurrent(page);
  await waitForPlans(page);
  const before = (await page.locator(".band-title").innerText()).trim();
  check("two answers saved, on question 3", before === "Question 3 / 42", before);
  await page.goBack();
  await page.waitForSelector("text=You have left the study");
  await shot(page, "21-left");
  check("browser back is treated as dropout", true);
  await button(page, "Return to the study").click();
  await waitForPlans(page);
  check("re-entry continues at the same position", (await page.locator(".band-title").innerText()).trim() === "Question 3 / 42");

  await page.reload();
  await waitForPlans(page);
  check("reload keeps the position", (await page.locator(".band-title").innerText()).trim() === "Question 3 / 42");
  await page.close();
}

console.log("\nImage failure and network failure");
{
  const page = await newPage(1440, 900, { expectFailedRequests: true });
  await page.goto(url("IMGFAIL", "&demo=1&failImage=1"));
  await page.waitForSelector("text=Study information");
  await page.getByRole("button", { name: "練習まで進める" }).click();
  await answerCurrent(page);
  await answerCurrent(page);
  await page.waitForFunction(() => document.querySelector(".band-title")?.textContent?.startsWith("Question 1"));
  await waitForPlans(page);
  check("broken question is replaced without stopping the participant", (await page.locator(".band-title").innerText()).trim() === "Question 1 / 42");
  await shot(page, "22-demo-guide");

  await page.context().setOffline(true);
  await clickChoice(page, "Floor plan C.");
  await button(page, "Continue").click();
  await page.waitForSelector(".connection-banner");
  await shot(page, "23-offline");
  check("offline save shows a retry message and stays on the question", (await page.locator(".band-title").innerText()).trim() === "Question 1 / 42");
  await page.context().setOffline(false);
  await page.waitForFunction(() => document.querySelector(".band-title")?.textContent?.startsWith("Question 2"), undefined, { timeout: 30000 });
  check("answer is saved automatically once back online", true);
  await page.close();
}

console.log("\nDemo guide shortcuts");
{
  const page = await newPage();
  await page.goto(url("GUIDE", "&demo=1"));
  await page.waitForSelector(".guide-panel");
  await shot(page, "24-guide-consent");
  await page.getByRole("button", { name: "練習まで進める" }).click();
  await waitForPlans(page);
  await page.getByRole("button", { name: "次の注意力確認まで自動回答" }).click();
  await page.waitForFunction(() => document.querySelector(".prompt")?.textContent?.includes("regardless of similarity"), undefined, { timeout: 60000 });
  await waitForPlans(page);
  check("guide jumps to question 16", (await page.locator(".band-title").innerText()).trim() === "Question 16 / 42");
  await shot(page, "25-guide-attention");
  await page.getByRole("button", { name: "本試行の最後まで自動回答" }).click();
  await page.waitForSelector("text=About your judgement", { timeout: 60000 });
  await page.getByRole("button", { name: "事後・属性質問を自動入力して完了" }).click();
  await page.waitForSelector("text=Your survey responses have been saved.");
  check("guide completes the study", true);
  await page.close();
}

console.log("\nAdmin");
{
  // The invalid completion URL check below deliberately triggers a 400.
  const page = await newPage(1440, 900, { expectFailedRequests: true });
  await page.goto(`${base}/admin`);
  await page.waitForSelector(".tile-row");
  await page.getByRole("button", { name: "模擬参加者を追加" }).click();
  await page.waitForSelector("text=模擬参加者を30人追加しました");
  await page.waitForTimeout(300);
  await shot(page, "26-admin-overview", true);
  await noOverflow(page, "admin overview");

  const download = async (label: string) => {
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: label }).click()]);
    const path = join(shots, file.suggestedFilename());
    await file.saveAs(path);
    const { readFileSync } = await import("node:fs");
    return readFileSync(path, "utf8");
  };
  const responses = parseCsv(await download("回答データCSV"));
  await download("参加者CSV");
  await download("問題別CSV");
  const header = responses[0];
  const col = (row: string[], name: string) => row[header.indexOf(name)];
  const full = responses.slice(1).filter((row) => col(row, "prolific_pid") === "FULLRUN");
  const main = full.filter((row) => col(row, "row_type") === "main");
  const attention = full.filter((row) => col(row, "row_type") === "attention");
  check("CSV has 40 main rows for the participant", main.length === 40, String(main.length));
  check("CSV has 2 attention rows, both passed", attention.length === 2 && attention.every((row) => col(row, "is_correct") === "1"));
  check("CSV has 2 separately labelled practice rows", full.filter((row) => col(row, "row_type") === "practice").length === 2);
  check("no duplicate question in CSV", new Set(main.map((row) => col(row, "triplet_id"))).size === 40);
  check("CSV carries Study and Session IDs", full.every((row) => col(row, "study_id") === "STUDY1" && col(row, "session_id") === "SES_FULLRUN"));
  check(
    "selected image ID is consistent with the answer",
    main.every((row) => {
      const answer = col(row, "response_value");
      if (answer === "B") return col(row, "selected_image_id") === col(row, "b_id");
      if (answer === "C") return col(row, "selected_image_id") === col(row, "c_id");
      return col(row, "selected_image_id") === "";
    }),
  );
  check("response times recorded", main.every((row) => Number(col(row, "rt_ms")) > 0));
  check("tie and cannot-judge answers saved", main.some((row) => col(row, "response_value") === "equal") && main.some((row) => col(row, "response_value") === "cannot_judge"));
  check(
    "left/right placement varies",
    new Set(main.map((row) => (col(row, "left_image_id") === col(row, "b_id") ? "b" : "c"))).size === 2,
  );
  const condition = (c: string) => main.filter((row) => col(row, "condition") === c).length;
  check("condition mix is 8/4/4/8/4/4/8", ["a", "d", "g"].every((c) => condition(c) === 8) && ["b", "c", "e", "f"].every((c) => condition(c) === 4));
  const comment = full.find((row) => col(row, "question_id") === "additional_comments");
  check("free text survives CSV quoting", comment !== undefined && col(comment, "response_text") === 'Comma, "quote" and\nnew line');
  const other = full.find((row) => col(row, "question_id") === "aspects_considered");
  check("Other text is exported", other !== undefined && col(other, "response_text") === "Balcony position");
  writeFileSync(join(shots, "fullrun-rows.txt"), String(full.length));

  await page.getByRole("button", { name: "調査を一時停止" }).click();
  await page.waitForSelector("text=一時停止中");
  const paused = await newPage();
  await paused.goto(url("NEWCOMER"));
  await paused.waitForSelector("text=This study is paused");
  check("pause blocks new participants", true);
  await shot(paused, "27-paused");
  await paused.close();
  await page.getByRole("button", { name: "調査を再開" }).click();
  await page.waitForSelector("text=受付中");

  await page.getByRole("button", { name: "問題別状況" }).click();
  await page.waitForSelector(".pager");
  await page.locator(".data-table .link-button.mono").first().click();
  await page.waitForSelector(".thumbs img");
  await page.waitForTimeout(300);
  await shot(page, "28-admin-items");

  await page.getByRole("button", { name: "参加者", exact: true }).click();
  await page.waitForSelector("text=FULLRUN");
  await shot(page, "29-admin-participants");

  await page.getByRole("button", { name: "データ取込・画像" }).click();
  await page.waitForSelector("text=検出能力の確認");
  check("image error from the failed run is listed", (await page.locator("text=デモで発生").count()) >= 1);
  await shot(page, "30-admin-data", true);

  await page.getByRole("button", { name: "調査設定" }).click();
  await page.waitForSelector("text=ProlificのStudy URL");
  check("N locks once participants exist", await page.getByLabel("本試行の出題数 N").isDisabled());
  await page.getByLabel("Prolificの完了URL").fill("https://example.org/done?cc=NEWCODE");
  await page.getByRole("button", { name: "設定を保存" }).click();
  await page.waitForSelector("text=保存しました");
  await shot(page, "31-admin-settings", true);
  await page.getByLabel("Prolificの完了URL").fill("not a url");
  await page.getByRole("button", { name: "設定を保存" }).click();
  await page.waitForSelector("text=完了URLは");
  check("invalid completion URL is rejected", true);
  await page.getByLabel("Prolificの完了URL").fill("/completion-preview?cc=DEMO1234");
  await page.getByRole("button", { name: "設定を保存" }).click();
  await page.waitForTimeout(500);

  await page.getByRole("button", { name: "シミュレーション" }).click();
  await page.getByRole("button", { name: "実行", exact: true }).click();
  await page.waitForSelector(".line-wrap svg", { timeout: 120000 });
  await page.waitForTimeout(300);
  await shot(page, "32-admin-simulation", true);
  await noOverflow(page, "simulation");

  await page.getByRole("button", { name: "動作試験" }).click();
  await page.getByRole("button", { name: "試験を開始" }).click();
  await page.waitForSelector("text=/✓ 一致|✕ 不一致/", { timeout: 120000 });
  check("load test: saved answers match the ledger", (await page.locator("text=✓ 一致").count()) === 1);
  await shot(page, "33-admin-tests", true);
  await page.close();
}

console.log("\nResponsive");
{
  for (const [name, width, height] of [
    ["laptop", 1280, 720],
    ["tablet", 820, 1180],
    ["phone", 390, 844],
  ] as const) {
    const page = await newPage(width, height);
    await page.goto(url(`RESP${name}`));
    await page.waitForSelector("text=Study information");
    await noOverflow(page, `consent ${name}`);
    await shot(page, `34-${name}-consent`);
    await passIntro(page);
    await waitForPlans(page);
    const boxes = await planBoxes(page);
    check(`${name}: three plans at the same size`, new Set(boxes.map((b) => `${b.w}x${b.h}`)).size === 1, JSON.stringify(boxes));
    check(`${name}: plans are a usable size`, boxes[0].w >= 150, String(boxes[0].w));
    await noOverflow(page, `trial ${name}`);
    await shot(page, `35-${name}-trial`, true);
    await page.locator(".plan-frame").first().click();
    await page.waitForSelector(".lightbox");
    await page.getByRole("tab", { name: "All three" }).click();
    await shot(page, `36-${name}-lightbox`);
    await page.close();
  }
  const page = await newPage(390, 844);
  await page.goto(`${base}/admin`);
  await page.waitForSelector(".tile-row");
  await noOverflow(page, "admin phone");
  await shot(page, "37-phone-admin", true);
  await page.goto(base);
  await page.waitForSelector(".tour");
  await noOverflow(page, "hub phone");
  await shot(page, "38-phone-hub", true);
  await page.close();
}

await browser.close();
check("no unexpected browser errors", consoleProblems.length === 0, consoleProblems.slice(0, 8).join("\n"));
console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) console.log("Failed:\n" + failures.map((f) => ` - ${f}`).join("\n"));
process.exit(failures.length ? 1 : 0);
