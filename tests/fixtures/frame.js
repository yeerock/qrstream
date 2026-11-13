// frames the page named in ?u= and counts the frame's load events, so a test can wait for the framed page instead of sleeping
window.frameLoads = 0; const f = document.querySelector('iframe'); f.addEventListener('load', () => { window.frameLoads++; });
f.src = new URLSearchParams(location.search).get('u');
