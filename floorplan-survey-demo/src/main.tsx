import { createRoot } from "react-dom/client";
import { lazy, StrictMode, Suspense } from "react";
import { CompletionPreview } from "./demo/CompletionPreview";
import { Hub } from "./demo/Hub";
import { Survey, surveyParams } from "./participant/Survey";
import "./styles.css";

const Admin = lazy(() => import("./admin/Admin"));

function App() {
  const path = window.location.pathname.replace(/\/$/, "");
  if (path === "/admin") {
    document.documentElement.lang = "ja";
    document.title = "管理画面 | 間取り図類似性調査";
    return (
      <Suspense fallback={<div className="page-loading" />}>
        <Admin />
      </Suspense>
    );
  }
  if (path === "/completion-preview") {
    document.documentElement.lang = "ja";
    document.title = "完了URLの遷移先（模擬）";
    return <CompletionPreview />;
  }
  const params = surveyParams();
  if (params.hasAny) return <Survey params={params} />;
  document.documentElement.lang = "ja";
  document.title = "デモ | 間取り図類似性評価アンケート";
  return <Hub />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
