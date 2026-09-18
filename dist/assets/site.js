const root = document.documentElement;
const body = document.body;
const themeToggle = document.querySelector(".theme-toggle");
const menuToggle = document.querySelector(".menu-toggle");

const storedTheme = localStorage.getItem("portfolio-theme");
const preferredTheme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
const initialTheme = storedTheme || preferredTheme;

function applyTheme(theme) {
  root.dataset.theme = theme;
  if (themeToggle) {
    themeToggle.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} mode`);
  }
}

applyTheme(initialTheme);

themeToggle?.addEventListener("click", () => {
  const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  localStorage.setItem("portfolio-theme", nextTheme);
});

menuToggle?.addEventListener("click", () => {
  const willOpen = !body.classList.contains("nav-open");
  body.classList.toggle("nav-open", willOpen);
  menuToggle.setAttribute("aria-expanded", String(willOpen));
  menuToggle.setAttribute("aria-label", willOpen ? "Close navigation" : "Open navigation");
});

document.addEventListener("click", (event) => {
  if (!body.classList.contains("nav-open")) return;
  if (event.target.closest(".sidebar") || event.target.closest(".menu-toggle")) return;
  body.classList.remove("nav-open");
  menuToggle?.setAttribute("aria-expanded", "false");
  menuToggle?.setAttribute("aria-label", "Open navigation");
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !body.classList.contains("nav-open")) return;
  body.classList.remove("nav-open");
  menuToggle?.setAttribute("aria-expanded", "false");
  menuToggle?.focus();
});

document.querySelectorAll("[data-current-year]").forEach((node) => {
  node.textContent = new Date().getFullYear();
});

const filter = document.querySelector("#project-filter");
const cards = [...document.querySelectorAll(".project-card")];
const emptyState = document.querySelector(".empty-state");

filter?.addEventListener("input", () => {
  const query = filter.value.trim().toLocaleLowerCase();
  let visibleCards = 0;

  cards.forEach((card) => {
    const isVisible = card.dataset.search.includes(query);
    card.hidden = !isVisible;
    if (isVisible) visibleCards += 1;
  });

  if (emptyState) emptyState.hidden = visibleCards !== 0;
});
