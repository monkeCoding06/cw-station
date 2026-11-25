<?php
declare(strict_types=1);

require __DIR__ . '/../src/bootstrap.php';

send_security_headers();
header('Cache-Control: no-store');

$user = current_user();
$account = $user === null ? null : find_account($user);
$h = static fn(string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
$rig = $account === null ? null : load_rig($user);
$rigAttrs = rig_attributes($rig ?? default_rig());
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CW Station</title>
<link rel="stylesheet" href="assets/style.css">
<script type="module" src="assets/js/main.js"></script>
</head>

<body data-user="<?= $h($user ?? '') ?>" data-claimed="<?= $account === null ? '0' : '1' ?>" data-rig="<?= $h($rig === null ? '' : json_encode($rig)) ?>">
<?php if ($user === null): ?>
<main class="login">
  <h1>CW Station</h1>
  <form id="loginForm" data-nokey>
    <input id="callsign" type="text" maxlength="12" placeholder="Callsign" aria-label="Callsign"
           autocomplete="username" autocapitalize="characters" spellcheck="false" required pattern="[A-Za-z0-9/]{3,12}">
    <input id="password" type="password" maxlength="72" placeholder="Password" aria-label="Password"
           autocomplete="current-password" hidden>
    <button>Enter</button>
  </form>
  <p class="claim-note">Choose a callsign for this CW simulator. Claiming it here has no legal effect and grants no on-air privileges.</p>
  <p id="loginError" role="alert"></p>
</main>
<?php else: ?>
<header class="top" data-nokey>
  <nav id="rooms" aria-label="Room">
    <button data-room="general" aria-pressed="false">General</button>
    <button data-room="echo" aria-pressed="false">Echo</button>
    <button data-room="practice" aria-pressed="false">Practice</button>
    <button data-room="training" aria-pressed="false">Training</button>
    <button id="awardsTab" type="button" aria-pressed="false">Awards</button>
  </nav>
  <div class="who">
    <strong><?= $h($user) ?></strong>
    <button id="listen" aria-pressed="false" title="Show others that you are only listening"><span class="long">Just receiving</span><span class="short">Listen</span></button>
<?php if ($account === null): ?>
    <button id="claim">Claim</button>
<?php endif; ?>
    <button id="rigEdit" type="button" aria-expanded="false"><span class="long">Customize rig</span><span class="short">Rig</span></button>
    <button id="qslOpen" type="button">QSL <b id="qslBadge" hidden></b></button>
    <button id="logToggle" type="button" aria-pressed="false">Log</button>
    <a class="report" href="https://github.com/monkeCoding06/cw-station/issues" target="_blank" rel="noopener noreferrer"><span class="long">Report bug</span><span class="short">Bug</span></a>
    <button id="logout"><span class="long">Sign out</span><span class="short">Exit</span></button>
  </div>
</header>

<?php if ($account === null): ?>
<form id="claimForm" class="claim" data-nokey hidden>
  <input id="claimPassword" type="password" maxlength="72" placeholder="New password (8+ characters)"
         aria-label="New password" autocomplete="new-password" required minlength="8">
  <button>Set password</button>
  <span id="claimError" role="alert"></span>
  <small class="claim-note">Choose a callsign for this CW simulator. Claiming it here has no legal effect and grants no on-air privileges.</small>
</form>
<?php endif; ?>

<main class="station">
  <section class="logbook" data-nokey>
    <div class="page left">
      <h2>Logbook <span class="clock">UTC <time id="logClock"></time></span></h2>
      <form id="logForm">
        <input id="logCall" type="text" maxlength="12" placeholder="Call worked" aria-label="Callsign worked"
               autocomplete="off" autocapitalize="characters" spellcheck="false" pattern="[A-Za-z0-9/]*">
        <textarea id="logText" rows="9" maxlength="2000" placeholder="Copy the exchange here" aria-label="Exchange"
                  spellcheck="false"></textarea>
        <button>Log it</button>
      </form>
      <p id="logStatus" role="status"><?= $account === null ? 'Guest logbook: kept in this browser until you claim.' : '' ?></p>
      <div class="prefix">
        <input id="prefixInput" type="text" maxlength="12" placeholder="Prefix lookup (oe2, ki7)" aria-label="Callsign prefix lookup"
               autocomplete="off" autocapitalize="characters" spellcheck="false">
        <p id="prefixResult" role="status"></p>
      </div>
    </div>
    <div class="page right">
      <input id="logSearch" type="search" placeholder="Search call or text" aria-label="Search logbook"
             autocomplete="off" spellcheck="false">
      <div id="logCount"></div>
      <ol id="logList"></ol>
    </div>
  </section>

  <div class="bench" id="bench"<?= $rigAttrs ?>>

    <!-- Receiver -->
    <section class="unit rig" id="rxRig" data-rooms="general echo practice" data-nokey>
      <i class="screw tl"></i><i class="screw tr"></i><i class="screw bl"></i><i class="screw br"></i>

      <div class="rig-top">
        <div class="window">
          <div class="lcd">
            <div id="dial">7030.000 kHz</div>
            <div class="lcd-line">
              VOL <output id="volOut"></output> RF <output id="rfOut"></output> BW <output id="bwOut"></output>
            </div>
          </div>
          <div class="scope">
            <div class="pane spectrum-pane"><canvas id="spectrum" aria-label="Spectrum. Click to tune."></canvas></div>
            <div class="pane"><canvas id="water" width="720" height="150" aria-label="Waterfall. Click to tune."></canvas></div>
            <i id="cursor"></i>
            <div id="powerHint">Receiver off<br><small>Flip the power switch to turn it on</small></div>
          </div>
          <div class="scale" aria-hidden="true">
            <span class="t0">7029</span><span class="t25">.5</span><span class="t50">7030</span><span class="t75">.5</span><span class="t100">7031 kHz</span>
          </div>
        </div>

        <div class="power-switch">
          <span class="legend">On</span>
          <button id="power" aria-pressed="false" aria-label="Power"></button>
          <span class="legend">Off</span>
        </div>
      </div>

      <div class="strip" data-strip></div>
      <div class="tapes" data-tapes></div>

      <div class="knobs">
        <div class="knob-group">
          <span class="legend">Volume</span>
          <div class="knob knob-lg" data-for="vol" data-label="Volume" data-unit="%" data-px="2"></div>
          <input id="vol" type="range" min="0" max="100" value="35" hidden>
        </div>
        <div class="knob-group">
          <span class="legend">RF gain</span>
          <div class="knob knob-sm" data-for="rf" data-label="RF gain" data-unit="dB" data-px="3"></div>
          <input id="rf" type="range" min="-36" max="48" value="0" hidden>
        </div>
        <div class="knob-group">
          <span class="legend">Bandwidth</span>
          <div class="knob knob-sm" data-for="bw" data-label="Bandwidth" data-sweep="100" data-px="24"></div>
          <select id="bw" hidden>
            <option>200 Hz</option>
            <option selected>500 Hz</option>
            <option>900 Hz</option>
          </select>
        </div>
        <div class="knob-group">
          <span class="legend">Tune</span>
          <div class="knob knob-xl" data-for="vfo" data-label="Tuning" data-unit="Hz from 7030 kHz" data-sweep="3600" data-px="5"></div>
          <input id="vfo" type="range" min="-10000" max="10000" step="100" value="0" hidden>
        </div>
      </div>

      <div class="tools">
        <button id="scan" type="button" aria-pressed="false" data-rooms="general" disabled>Scan</button>
        <button id="share" type="button" data-rooms="general" title="Copy a link to this frequency">Share</button>
        <button id="tuneStep" type="button" aria-pressed="false" title="Tuning step">100 Hz</button>
      </div>
    </section>

    <!-- Training -->
    <section class="unit rig training" data-rooms="training" data-nokey>
      <i class="screw tl"></i><i class="screw tr"></i><i class="screw bl"></i><i class="screw br"></i>

      <div class="rig-top">
        <div class="window">
          <div class="lcd" id="trainLcd">
            <div id="trainChar" aria-live="polite">–</div>
            <div id="trainMorse">&nbsp;</div>
            <pre id="trainCopy" class="train-copy" aria-live="polite" hidden></pre>
            <div class="lcd-line"><span id="trainPos">&nbsp;</span></div>
            <div class="lcd-line" id="trainStatus" role="status">Choose a method</div>
          </div>
          <div class="train-row">
            <label><span class="legend">Method</span>
              <select id="trainMode">
                <option value="" selected disabled>Choose…</option>
                <option>Farnsworth</option>
                <option>Koch</option>
                <option>Alphabetical</option>
                <option>Single letters</option>
                <option>Tune in</option>
              </select>
            </label>
            <label id="trainFallLabel" class="train-fall" hidden>
              <input type="checkbox" id="trainFall"> <span class="legend">Waterfall</span>
            </label>
          </div>
        </div>
      </div>

      <div class="strip" data-strip></div>
      <div class="tapes" data-tapes></div>

      <div class="knobs">
        <div class="knob-group" id="trainSpeedGroup">
          <span class="legend"><span id="trainSpeedLabel">Character speed</span> <output id="trainSpeedOut"></output></span>
          <div class="knob knob-xl" data-for="trainSpeed" data-label="Character speed" data-unit="WPM" data-px="8"></div>
          <input id="trainSpeed" type="range" min="5" max="40" value="20" hidden>
        </div>
        <div class="knob-group" id="trainEffGroup" hidden>
          <span class="legend">Effective speed <output id="trainEffOut"></output></span>
          <div class="knob knob-xl" data-for="trainEff" data-label="Effective speed" data-unit="WPM" data-px="8"></div>
          <input id="trainEff" type="range" min="5" max="40" value="10" hidden>
        </div>
        <div class="knob-group">
          <span class="legend">Volume <output id="trainVolOut"></output></span>
          <div class="knob knob-lg" data-for="vol" data-label="Volume" data-unit="%" data-px="2"></div>
        </div>
      </div>

      <div class="tools">
        <button id="trainReplay" type="button" disabled>Replay</button>
        <button id="trainCheck" type="button" hidden disabled>Check copy</button>
        <button id="trainNext" type="button" hidden disabled>Next</button>
        <button id="trainRestart" type="button" disabled>Restart</button>
      </div>
    </section>

    <!-- Keyer -->
    <section class="unit keyer" data-rooms="general echo practice training">
      <i class="screw tl"></i><i class="screw tr"></i><i class="screw bl"></i><i class="screw br"></i>

      <div class="type-box" data-nokey hidden>
        <label><span class="legend">Type the letter you heard</span>
          <input id="trainType" class="train-type" maxlength="2" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="?">
        </label>
      </div>

      <div class="type-box notes-box" id="trainNotesBox" data-nokey hidden>
        <label><span class="legend">Your notes</span>
          <textarea id="trainNotes" rows="6" maxlength="1000" autocomplete="off" spellcheck="false" placeholder="Write down what you hear"></textarea>
        </label>
      </div>

      <div class="readout" data-rooms="echo practice training">
        <pre id="rx" aria-live="polite">▏</pre>
        <div class="readout-foot" data-nokey>
          <div id="signal">Ready</div>
          <button id="clearDecoder">Clear</button>
        </div>
      </div>

      <div id="pad" class="pad">
        <button id="padDit" type="button"></button>
        <button id="padDah" type="button">Dah  −</button>
      </div>

      <div class="settings" data-nokey>
        <label><span class="legend">Keyer</span>
          <select id="mode">
            <option>Iambic B</option>
            <option>Iambic A</option>
            <option>Straight key</option>
          </select>
        </label>
        <label data-rooms="general echo practice"><span class="legend">Speed <output id="speedOut"></output></span>
          <input type="range" id="speed" min="5" max="40" value="16">
        </label>
        <button id="moreToggle" class="more-btn" type="button" aria-expanded="false">More</button>
        <div class="more">
          <label><span class="legend">Sidetone <output id="pitchOut"></output></span>
            <input type="range" id="pitch" min="350" max="950" step="10" value="600">
          </label>
          <div class="keymap">
            <span class="legend">Keys</span>
            <span>Dit <button id="ditKey" type="button" title="Click, then press a key"></button></span>
            <span>Dah <button id="dahKey" type="button" title="Click, then press a key"></button></span>
            <span data-serial hidden><button id="serialKey" type="button" title="Connect a serial paddle (ESP32 touch keyer)">USB paddle</button></span>
          </div>
          <label data-rooms="general echo"><span class="legend">Latency <output id="latencyOut"></output></span>
            <input type="range" id="latency" min="0" max="3000" step="50" value="0">
          </label>
        </div>
      </div>
    </section>
  </div>

  <section id="awardsPage" class="awards-page" data-nokey aria-label="Awards"></section>

  <div class="side">
    <aside id="onlinePanel" data-nokey>
      <h2>Online <span id="onlineCount">0</span></h2>
      <small id="cwConnection" role="status"></small>
      <ul id="onlineList"></ul>
      <button id="chatToggle" type="button" aria-expanded="false" aria-controls="chatBox">Chat</button>
      <div id="chatBox" class="chat-box">
        <h2 class="chat-title">Chat <button id="chatPing" type="button" aria-pressed="false" title="Play a ping when someone else writes">Ping off</button><button id="chatClose" type="button">Close</button></h2>
        <ol id="chatLog" aria-live="polite"></ol>
        <form id="chatForm" autocomplete="off">
          <input id="chatText" disabled type="text" maxlength="200" placeholder="Say something" aria-label="Chat message">
          <button id="chatSend" disabled type="submit">Send</button>
        </form>
        <small id="chatError" role="alert"></small>
      </div>
    </aside>

    <details data-nokey>
      <summary>Morse chart</summary>
      <div class="ref" id="ref"></div>
    </details>
  </div>

  <div id="rigEditor" class="sheet" data-nokey hidden></div>
  <div id="rigView" class="overlay" data-nokey hidden></div>
  <div id="qslPanel" class="overlay" data-nokey hidden></div>
  <div id="callMenu" class="menu" data-nokey hidden></div>

  <footer class="foot" data-nokey>
    Made by OE2FOX with <3 · Heavily inspired by <a href="https://vailmorse.com" target="_blank" rel="noopener noreferrer">vailmorse.com</a> · <a href="https://github.com/monkeCoding06" target="_blank" rel="noopener noreferrer">GitHub</a>
  </footer>
</main>
<?php endif; ?>
</body>
</html>
