"use strict";

(() => {
  const i18n = window.RetroI18n;
  const language = document.getElementById("language-select");
  i18n.bindLanguageSelect(language);
  i18n.apply();
})();
