// Se ejecuta en segundo plano, aunque la ventana de RingAnime esté cerrada.
importScripts("check.js");

const ALARM_NAME = "ringanime-check";

// Revisión automática cada 3 horas
function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 180 });
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  RingCheck.runCheck(); // al abrir el navegador, revisamos de inmediato
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) RingCheck.runCheck();
});
ensureAlarm();

// Al tocar una notificación, abrimos la página del anime en AniList
chrome.notifications.onClicked.addListener((notificationId) => {
  // El id tiene la forma: "tipo|idDelAnime|hora"
  const animeId = notificationId.split("|")[1];
  if (animeId && animeId !== "0") {
    chrome.tabs.create({ url: "https://anilist.co/anime/" + animeId });
  }
  chrome.notifications.clear(notificationId);
});
