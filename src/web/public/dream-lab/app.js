(() => {
  "use strict";
  const moduleApi = window.StoneDeveloperModule;
  const threadId = moduleApi?.threadId || "";
  const enabled = document.querySelector("#enabled");
  const status = document.querySelector("#status");
  const latest = document.querySelector("#latest");
  const date = document.querySelector("#date");
  const dreamDate = document.querySelector("#dream-date");
  const generate = document.querySelector("#generate");
  let pollTimer = null;

  function renderDream(dream) {
    if (!dream) {
      latest.className = "dream empty";
      latest.textContent = "还没有梦境。";
      return;
    }
    latest.className = "dream";
    latest.innerHTML = `<div><span>${escapeHtml(dream.date)}</span><span>${escapeHtml(dream.dreamType)}</span></div><h2>${escapeHtml(dream.title || "无题")}</h2><p>${escapeHtml(dream.body).replace(/\n/g, "<br>")}</p>`;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }
  async function load(selectedDreamDate = dreamDate.value) {
    if (!threadId) throw new Error("缺少当前记忆体，请返回开发者模块重新进入");
    const query = selectedDreamDate ? `?date=${encodeURIComponent(selectedDreamDate)}` : "";
    const data = await moduleApi.api(`/api/libraries/${encodeURIComponent(threadId)}/dreams${query}`);
    enabled.checked = data.enabled === true;
    const selectedDate = date.value;
    const eligibleDates = data.eligibleDates || [];
    date.innerHTML = eligibleDates.slice().reverse()
      .map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    if (selectedDate && eligibleDates.includes(selectedDate)) date.value = selectedDate;
    date.disabled = eligibleDates.length === 0;
    generate.disabled = eligibleDates.length === 0 || data.job?.status === "running";
    dreamDate.innerHTML = (data.dreamDates || []).slice().reverse()
      .map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
    if (data.selectedDate) dreamDate.value = data.selectedDate;
    dreamDate.disabled = !data.dreamDates?.length;
    const count = data.coverage?.availableDates?.length || 0;
    const missing = data.coverage?.missingDates?.length || 0;
    if (data.job?.status === "running") {
      status.textContent = `正在织造 ${data.job.date} 的梦境，页面可以继续使用……`;
      generate.textContent = "正在织梦……";
      clearTimeout(pollTimer);
      pollTimer = setTimeout(load, 2000);
    } else if (data.job?.status === "failed") {
      status.textContent = `${data.job.date} 织梦失败：${data.job.error}`;
      generate.textContent = "重新织梦";
    } else {
      status.textContent = `${enabled.checked ? "自动织梦已开启" : "自动织梦已关闭"} · 已保存 ${count} 场${missing ? ` · 启用后漏织 ${missing} 天` : ""}`;
      generate.textContent = "立即织梦";
    }
    renderDream(data.latest);
  }
  enabled.onchange = async () => {
    enabled.disabled = true;
    status.textContent = "正在保存并刷新 watcher……";
    try {
      await moduleApi.api(`/api/libraries/${encodeURIComponent(threadId)}/settings`, {
        method: "PATCH",
        body: JSON.stringify({ automaticDream: enabled.checked }),
      });
      await load();
    } catch (error) {
      enabled.checked = !enabled.checked;
      status.textContent = error.message;
    } finally {
      enabled.disabled = false;
    }
  };
  dreamDate.onchange = () => load(dreamDate.value).catch(error => { status.textContent = error.message; });
  generate.onclick = async () => {
    generate.disabled = true;
    generate.textContent = "正在织梦……";
    try {
      await moduleApi.api(`/api/libraries/${encodeURIComponent(threadId)}/dreams/generate`, {
        method: "POST",
        body: JSON.stringify({ date: date.value }),
      });
      await load();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      if (generate.textContent !== "正在织梦……") generate.disabled = false;
    }
  };
  load().catch(error => { status.textContent = error.message; });
})();
