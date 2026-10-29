chrome.action.onClicked.addListener(async (tab) => {
  const target = new URL(chrome.runtime.getURL("dashboard.html"));
  try {
    const source = new URL(tab.url);
    if (["http:", "https:"].includes(source.protocol)) {
      target.searchParams.set("server", source.origin);
    }
  } catch { /* The user can enter a server manually. */ }
  await chrome.tabs.create({ url: target.href });
});
