// Copy button
document.querySelectorAll('.code-wrap').forEach((wrap) => {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'copy';
  btn.addEventListener('click', () => {
    const text = wrap.querySelector('pre').textContent;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1800);
    });
  });
  wrap.appendChild(btn);
});

// Collapsible endpoints
document.querySelectorAll('.endpoint-header').forEach((header) => {
  header.addEventListener('click', () => {
    header.closest('.endpoint').classList.toggle('open');
  });
});

// Tabs
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const group = tab.closest('.tabs').getAttribute('data-group');
    const target = tab.getAttribute('data-tab');
    document.querySelectorAll(`[data-group="${group}"] .tab`).forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const endpointBody = tab.closest('.endpoint-body');
    endpointBody.querySelectorAll(`.tab-content`).forEach((c) => {
      c.classList.toggle('active', c.getAttribute('data-tab') === target);
    });
  });
});

// Search
const searchInput = document.getElementById('search-input');
const navLinks = document.querySelectorAll('.nav-link');

searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase();
  document.querySelectorAll('.nav-section').forEach((section) => {
    let visible = 0;
    section.querySelectorAll('.nav-link').forEach((link) => {
      const match = !q || link.textContent.toLowerCase().includes(q);
      link.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    section.style.display = !q || visible ? '' : 'none';
  });
});

// Active nav link on scroll
const sections = document.querySelectorAll('.section');
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      const id = entry.target.id;
      navLinks.forEach((link) => {
        link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
      });
    }
  }
}, { rootMargin: '-20% 0px -70% 0px' });

sections.forEach((s) => observer.observe(s));
