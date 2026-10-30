const fs = require('fs');
const path = require('path');

const targetFile = 'd:/WORKSPACE/CINE-BOX/CinemBroadAPK/src/components/media/unsandboxed-frame.tsx';
let content = fs.readFileSync(targetFile, 'utf8');

const target = `        if (v.paused) {
          v.muted = false;
          v.play().catch(function() {
            v.muted = true;
            v.play();
          });
        }
      }

      // Auto-trigger video play buttons inside embedded web players
      var playBtns = document.querySelectorAll('.play-btn, .vjs-big-play-button, .jw-display-icon-container, [aria-label*="Play"], button[title*="Play"], .play, #play');
      for (var i = 0; i < playBtns.length; i++) {
        try { playBtns[i].click(); } catch(e) {}
      }`;

const replacement = `        if (v.paused) {
          v.muted = false;
          v.play().catch(function() {
            v.muted = true;
            v.play();
          });
        }

        // Auto-select Hindi audio track if available in HTML5 video audioTracks
        try {
          if (v.audioTracks && v.audioTracks.length > 1) {
            for (var a = 0; a < v.audioTracks.length; a++) {
              var track = v.audioTracks[a];
              var lang = (track.language || track.label || '').toLowerCase();
              if (lang.indexOf('hin') !== -1 || lang.indexOf('hindi') !== -1 || lang.indexOf('dub') !== -1) {
                for (var b = 0; b < v.audioTracks.length; b++) v.audioTracks[b].enabled = false;
                track.enabled = true;
                break;
              }
            }
          }
        } catch(e) {}
      }

      // Auto-trigger video play buttons inside embedded web players
      var playBtns = document.querySelectorAll('.play-btn, .vjs-big-play-button, .jw-display-icon-container, [aria-label*="Play"], button[title*="Play"], .play, #play');
      for (var i = 0; i < playBtns.length; i++) {
        try { playBtns[i].click(); } catch(e) {}
      }

      // Auto-click Hindi audio button in web player UI if present
      try {
        var audioMenuItems = document.querySelectorAll('li, div, button, span');
        for (var m = 0; m < audioMenuItems.length; m++) {
          var itemText = (audioMenuItems[m].innerText || audioMenuItems[m].textContent || '').trim().toLowerCase();
          if (itemText === 'hindi' || itemText === 'hin' || itemText === 'hindi dubbed') {
            audioMenuItems[m].click();
            break;
          }
        }
      } catch(e) {}`;

const normalizedContent = content.replace(/\r\n/g, '\n');
const normalizedTarget = target.replace(/\r\n/g, '\n');
const normalizedReplacement = replacement.replace(/\r\n/g, '\n');

if (normalizedContent.includes(normalizedTarget)) {
  const updated = normalizedContent.replace(normalizedTarget, normalizedReplacement);
  fs.writeFileSync(targetFile, updated, 'utf8');
  console.log('SUCCESS: unsandboxed-frame.tsx updated with Hindi auto-audio selector!');
} else {
  console.error('ERROR: target not found in unsandboxed-frame.tsx');
}

