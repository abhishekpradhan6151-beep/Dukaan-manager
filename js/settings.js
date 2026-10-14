/*
 * settings.js - shop details used on receipts (name, address, phone, invoice
 * prefix, receipt footer). Saved in IndexedDB. The rest of Settings (tax
 * defaults, backup and restore) is still to come.
 */
(function () {
  "use strict";

  const DB = window.DukaanDB;
  const U = window.DukaanUtil;
  const $ = U.$;

  const DEFAULTS = { name: "", phone: "", address: "", prefix: "INV", footer: "Thank you! Visit again." };
  let current = Object.assign({}, DEFAULTS);
  let saving = false;

  function updateHeader() {
    $("shopName").textContent = current.name || "Your shop";
    $("shopSub").textContent = current.name ? "" : "Set your shop name in Settings";
  }

  function fillForm() {
    $("stName").value = current.name;
    $("stPhone").value = current.phone;
    $("stAddress").value = current.address;
    $("stPrefix").value = current.prefix;
    $("stFooter").value = current.footer;
  }

  function load() {
    return DB.run(["settings"], "readonly", (tx) => DB.req(tx.objectStore("settings").get("shop")))
      .then((rec) => { current = Object.assign({}, DEFAULTS); if (rec && rec.value) current = Object.assign({}, DEFAULTS, rec.value); })
      .catch(() => { /* storage problems are reported by the other screens */ })
      .then(() => { fillForm(); updateHeader(); document.dispatchEvent(new CustomEvent("settings-changed")); });
  }

  async function onSave(e) {
    e.preventDefault();
    if (saving) return;
    const v = {
      name: $("stName").value.trim(), phone: $("stPhone").value.trim(), address: $("stAddress").value.trim(),
      prefix: $("stPrefix").value.trim().toUpperCase(), footer: $("stFooter").value.trim()
    };
    const errs = {};
    if (v.name.length > 80) errs.stName = "Shop name is too long (max 80 characters).";
    if (v.phone.length > 20) errs.stPhone = "Phone number is too long.";
    if (v.address.length > 200) errs.stAddress = "Address is too long (max 200 characters).";
    if (!/^[A-Z0-9]{1,8}$/.test(v.prefix)) errs.stPrefix = "Use 1 to 8 letters or digits, for example INV.";
    if (v.footer.length > 120) errs.stFooter = "Footer is too long (max 120 characters).";

    ["stName", "stPhone", "stAddress", "stPrefix", "stFooter"].forEach((id) => {
      const span = $("e-" + id);
      span.textContent = errs[id] || "";
      if (errs[id]) $(id).setAttribute("aria-invalid", "true"); else $(id).removeAttribute("aria-invalid");
    });
    const first = Object.keys(errs)[0];
    if (first) { $(first).focus(); return; }

    saving = true;
    $("stSave").disabled = true;
    $("stBanner").hidden = true;
    try {
      await DB.run(["settings"], "readwrite", (tx) => { tx.objectStore("settings").put({ key: "shop", value: v, updatedAt: DB.now() }); });
      current = Object.assign({}, DEFAULTS, v);
      updateHeader();
      U.toast("Shop details saved.");
      document.dispatchEvent(new CustomEvent("settings-changed"));
    } catch (err) {
      $("stBanner").textContent = err.message;
      $("stBanner").hidden = false;
    } finally {
      saving = false;
      $("stSave").disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("shopForm").addEventListener("submit", onSave);
    load();
  });

  window.DukaanSettings = { get: () => Object.assign({}, current), reload: load };
})();
