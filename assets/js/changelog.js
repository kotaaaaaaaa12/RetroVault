"use strict";

(() => {
  const i18n = window.RetroI18n;
  const language = document.getElementById("language-select");
  language.value = i18n.mode;
  language.addEventListener("change", () => i18n.setLanguage(language.value));
  i18n.onChange(() => { language.value = i18n.mode; });
  i18n.apply();
})();
