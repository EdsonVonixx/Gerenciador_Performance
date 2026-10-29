const root = document.documentElement;
const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
const themeStorageKey = "vpc-display-theme";

function applyTheme(choice, persist = true) {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = choice;
  themeButtons.forEach((button) => {
    const active = button.dataset.themeChoice === choice;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (persist) localStorage.setItem(themeStorageKey, choice);
  window.dispatchEvent(new Event("resize"));
}

const storedTheme = localStorage.getItem(themeStorageKey);
applyTheme(["light", "dark", "system"].includes(storedTheme) ? storedTheme : "light", false);
themeButtons.forEach((button) => button.addEventListener("click", () => applyTheme(button.dataset.themeChoice)));

function animateFirstView(panel) {
  if (!panel || panel.dataset.animated === "true") return;
  panel.classList.add("vpc-enter");
  window.setTimeout(() => {
    panel.classList.remove("vpc-enter");
    panel.dataset.animated = "true";
  }, 760);
}

const appShell = document.querySelector("#appShell");
if (appShell) {
  new MutationObserver(() => {
    if (!appShell.classList.contains("hidden")) {
      animateFirstView(document.querySelector("[data-view-panel].active"));
    }
  }).observe(appShell, { attributes: true, attributeFilter: ["class"] });
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".nav-item[data-view]")) return;
  requestAnimationFrame(() => animateFirstView(document.querySelector("[data-view-panel].active")));
});

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let pointerX = 0;
  let pointerY = 0;
  let framePending = false;
  document.addEventListener("mousemove", (event) => {
    pointerX = event.clientX / window.innerWidth - 0.5;
    pointerY = event.clientY / window.innerHeight - 0.5;
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      document.querySelectorAll("[data-depth]").forEach((element) => {
        const depth = Number(element.dataset.depth) || 0;
        const rotation = element.dataset.rot ? ` rotate(${element.dataset.rot}deg)` : "";
        element.style.transform = `translate(${(pointerX * depth).toFixed(1)}px, ${(pointerY * depth).toFixed(1)}px)${rotation}`;
      });
    });
  }, { passive: true });

  if (window.matchMedia("(hover: hover)").matches) {
    let activeSurface = null;
    const release = (element) => {
      if (!element) return;
      element.style.transform = "";
      element.classList.remove("lift");
    };
    document.addEventListener("pointermove", (event) => {
      const surface = event.target.closest?.(".panel, .kpi-card, .status-card, .line-card, .tv-sector-card, .tv-alerts-card, .tv-insight-card");
      if (surface !== activeSurface) release(activeSurface);
      activeSurface = surface;
      if (!surface) return;
      const bounds = surface.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      surface.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
      surface.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
      surface.classList.add("lift");
      const hasControls = surface.querySelector("table, input, select, textarea, button");
      const tilt = surface.matches(".kpi-card, .status-card") ? 2 : hasControls ? 0 : 0.8;
      surface.style.transform = tilt
        ? `perspective(1000px) rotateX(${((0.5 - y) * tilt).toFixed(2)}deg) rotateY(${((x - 0.5) * tilt).toFixed(2)}deg) translateY(-2px)`
        : "translateY(-2px)";
    }, { passive: true });
    const clear = () => { release(activeSurface); activeSurface = null; };
    document.addEventListener("pointerleave", clear);
    window.addEventListener("blur", clear);
  }
}
