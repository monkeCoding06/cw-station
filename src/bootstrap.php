<?php
declare(strict_types=1);

/**
 * Shared server code: configuration, database, security headers and the
 * cookie-based identity ("callsign") used by index.php and api.php.
 *
 * Requires PHP 8.1+ with the pdo_sqlite extension.
 */

const DATA_DIR = __DIR__ . '/../data';       // outside the web root, never served
const ROOMS = ['general'];                   // rooms stored on the server
const COOKIE_LIFETIME = 365 * 24 * 3600;
const CALLSIGN_PATTERN = '/^[A-Z0-9\/]{3,12}$/';
const MAX_ACCOUNTS = 5000;                   // stops account-flooding
const MAX_LOG_CHARS = 2000;
const MAX_LOG_ENTRIES = 2000;
const LOGIN_FAILURE_WINDOW = 15 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGES_PER_MINUTE = 100;
const KEEP_MESSAGES_PER_ROOM = 200;
const ONLINE_WINDOW_SECONDS = 8;             // clients ping every 3 s

require __DIR__ . '/profile.php';
require __DIR__ . '/awards.php';

class ApiError extends RuntimeException
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

/** The page loads only its own scripts and styles; nothing inline, nothing external. */
function send_security_headers(): void
{
    // older Safari does not count wss:// as 'self', so the live CW socket is listed explicitly
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    $live = preg_match('/^[a-z0-9.-]+(:[0-9]{1,5})?$/iD', $host) === 1 ? " wss://$host" : '';
    header("Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; "
        . "img-src 'self'; connect-src 'self'$live; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: no-referrer');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    if (!is_dir(DATA_DIR) && !mkdir(DATA_DIR, 0750, true) && !is_dir(DATA_DIR)) {
        throw new RuntimeException('Cannot create data directory');
    }

    $pdo = new PDO('sqlite:' . DATA_DIR . '/cw.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 3000');
    // the logbook replaces the old single notes field; its text is carried over once
    $hadLogbook = (bool) $pdo->query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'log_entries'")->fetchColumn();
    $pdo->exec('
        DROP TABLE IF EXISTS users;
        CREATE TABLE IF NOT EXISTS accounts (
            callsign      TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            notes         TEXT NOT NULL DEFAULT \'\'
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            callsign   TEXT NOT NULL,
            last_seen  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_by_callsign ON sessions (callsign);
        CREATE TABLE IF NOT EXISTS login_failures (
            ip       TEXT NOT NULL,
            callsign TEXT NOT NULL,
            at       INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS log_entries (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            callsign  TEXT NOT NULL,
            logged_at INTEGER NOT NULL,
            contact   TEXT NOT NULL DEFAULT \'\',
            body      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS log_entries_by_owner ON log_entries (callsign, id);
        CREATE TABLE IF NOT EXISTS messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            room       TEXT NOT NULL,
            callsign   TEXT NOT NULL,
            text       TEXT NOT NULL,
            lead_ms    INTEGER NOT NULL,
            marks      TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_by_room ON messages (room, id);
        CREATE INDEX IF NOT EXISTS messages_by_user ON messages (callsign, created_at);
        CREATE TABLE IF NOT EXISTS rig_profiles (
            callsign   TEXT PRIMARY KEY,
            config     TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS qsl_designs (
            callsign   TEXT PRIMARY KEY,
            design     TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS qsl_images (
            owner      TEXT NOT NULL,
            hash       TEXT NOT NULL,
            ext        TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (owner, hash)
        );
        CREATE INDEX IF NOT EXISTS qsl_images_by_hash ON qsl_images (hash);
        CREATE TABLE IF NOT EXISTS qsl_cards (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            from_call  TEXT NOT NULL,
            to_call    TEXT NOT NULL,
            sent_at    INTEGER NOT NULL,
            image_hash TEXT,
            card       TEXT NOT NULL,
            seen       INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS qsl_cards_to ON qsl_cards (to_call, id);
        CREATE INDEX IF NOT EXISTS qsl_cards_from ON qsl_cards (from_call, sent_at);
        CREATE TABLE IF NOT EXISTS achievements (
            callsign    TEXT NOT NULL,
            name        TEXT NOT NULL,
            unlocked_at INTEGER NOT NULL,
            PRIMARY KEY (callsign, name)
        );
        CREATE TABLE IF NOT EXISTS train_counts (
            callsign TEXT PRIMARY KEY,
            n        INTEGER NOT NULL,
            last_at  INTEGER NOT NULL
        );
    ');

    // logged_at 0 marks text that was written before entries were timestamped
    if (!$hadLogbook) {
        $pdo->exec("INSERT INTO log_entries (callsign, logged_at, contact, body)
                    SELECT callsign, 0, '', notes FROM accounts WHERE trim(notes) != ''");
    }

    // older databases lack the frequency column
    $columns = $pdo->query('PRAGMA table_info(messages)')->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('freq_hz', $columns, true)) {
        $pdo->exec('ALTER TABLE messages ADD COLUMN freq_hz INTEGER NOT NULL DEFAULT 0');
    }
    $sessionColumns = $pdo->query('PRAGMA table_info(sessions)')->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('listening', $sessionColumns, true)) {
        $pdo->exec('ALTER TABLE sessions ADD COLUMN listening INTEGER NOT NULL DEFAULT 0');
    }
    if (!in_array('activity', $sessionColumns, true)) {
        $pdo->exec("ALTER TABLE sessions ADD COLUMN activity TEXT NOT NULL DEFAULT ''");
    }
    if (!in_array('freq_hz', $sessionColumns, true)) {
        $pdo->exec('ALTER TABLE sessions ADD COLUMN freq_hz INTEGER');
    }

    return $pdo;
}

/* ---------- Identity: one session cookie, the callsign lives on the server ---------- */

function cookie_options(int $expires): array
{
    return [
        'expires' => $expires,
        'path' => '/',
        'secure' => ($_SERVER['HTTPS'] ?? '') === 'on',
        'httponly' => true,
        'samesite' => 'Lax',
    ];
}

function normalize_callsign(string $raw): string
{
    $callsign = strtoupper(trim($raw));
    if (preg_match(CALLSIGN_PATTERN, $callsign) !== 1) {
        throw new ApiError(400, 'Callsign must be 3-12 characters: A-Z, 0-9 or /');
    }
    return $callsign;
}

function token_hash(string $token): string
{
    return hash('sha256', $token);
}

/** Returns the signed-in callsign, or null. The session cookie must match a stored token hash. */
function current_user(): ?string
{
    $token = (string) ($_COOKIE['cw_token'] ?? '');
    if (preg_match('/^[a-f0-9]{64}$/', $token) !== 1) {
        return null;
    }

    $stmt = db()->prepare('SELECT callsign FROM sessions WHERE token_hash = ?');
    $stmt->execute([token_hash($token)]);
    $callsign = $stmt->fetchColumn();

    return $callsign === false ? null : $callsign;
}

/** Marks this browser's session as active. 0 means "gone" (used when the page closes). */
function touch_session(int $lastSeen, ?bool $listening = null, ?string $activity = null, ?int $freq = null): void
{
    $token = token_hash((string) ($_COOKIE['cw_token'] ?? ''));
    $set = ['last_seen = ?'];
    $args = [$lastSeen];
    if ($listening !== null) {
        $set[] = 'listening = ?';
        $args[] = (int) $listening;
    }
    if ($activity !== null) {
        $set[] = 'activity = ?';
        $args[] = $activity;
    }
    if ($freq !== null) {
        $set[] = 'freq_hz = ?';
        $args[] = $freq;
    }
    $args[] = $token;
    db()->prepare('UPDATE sessions SET ' . implode(', ', $set) . ' WHERE token_hash = ?')->execute($args);
}

/**
 * Recently active callsigns, one entry each. "Just receiving" only if every session of it says so.
 * The activity is the one reported by the callsign's most recently active session.
 */
function online_callsigns(): array
{
    $stmt = db()->prepare(
        'SELECT callsign, MIN(listening) AS listening,
                (SELECT s2.activity FROM sessions s2 WHERE s2.callsign = s.callsign AND s2.last_seen > :since
                 ORDER BY s2.last_seen DESC, s2.token_hash LIMIT 1) AS activity,
                (SELECT s2.freq_hz FROM sessions s2 WHERE s2.callsign = s.callsign AND s2.last_seen > :since
                 ORDER BY s2.last_seen DESC, s2.token_hash LIMIT 1) AS freq_hz
         FROM sessions s WHERE last_seen > :since GROUP BY callsign ORDER BY callsign LIMIT 50'
    );
    $stmt->execute(['since' => time() - ONLINE_WINDOW_SECONDS]);
    return array_map(static fn(array $row): array => [
        'call' => $row['callsign'],
        'listening' => (int) $row['listening'] === 1,
        'activity' => (string) $row['activity'],
        // the tuned frequency is only shared while on air
        'freq' => $row['activity'] === 'general' && $row['freq_hz'] !== null ? (int) $row['freq_hz'] : null,
    ], $stmt->fetchAll());
}

function find_account(string $callsign): ?array
{
    $stmt = db()->prepare('SELECT callsign, password_hash, notes FROM accounts WHERE callsign = ?');
    $stmt->execute([$callsign]);
    return $stmt->fetch() ?: null;
}

/** Blocks password guessing: too many recent failures from one address or against one callsign. */
function check_login_allowed(string $callsign): void
{
    $pdo = db();
    $since = time() - LOGIN_FAILURE_WINDOW;
    $pdo->prepare('DELETE FROM login_failures WHERE at < ?')->execute([$since]);

    $byIp = $pdo->prepare('SELECT COUNT(*) FROM login_failures WHERE ip = ?');
    $byIp->execute([$_SERVER['REMOTE_ADDR'] ?? '']);
    $byCall = $pdo->prepare('SELECT COUNT(*) FROM login_failures WHERE callsign = ?');
    $byCall->execute([$callsign]);

    if ((int) $byIp->fetchColumn() >= 10 || (int) $byCall->fetchColumn() >= 30) {
        throw new ApiError(429, 'Too many failed attempts, try again in a few minutes');
    }
}

function record_login_failure(string $callsign): void
{
    db()->prepare('INSERT INTO login_failures (ip, callsign, at) VALUES (?, ?, ?)')
        ->execute([$_SERVER['REMOTE_ADDR'] ?? '', $callsign, time()]);
}

/** Signs in. A claimed callsign needs its password; any other callsign is a guest session. */
function login(string $rawCallsign, string $password): string
{
    $callsign = normalize_callsign($rawCallsign);
    $pdo = db();
    check_login_allowed($callsign);

    $account = find_account($callsign);
    if ($account !== null) {
        if ($password === '') {
            throw new ApiError(403, 'This callsign is claimed. Enter its password.');
        }
        if (!password_verify($password, $account['password_hash'])) {
            record_login_failure($callsign);
            throw new ApiError(403, 'Wrong password');
        }
    }

    $pdo->prepare('DELETE FROM sessions WHERE last_seen < ?')->execute([time() - 90 * 86400]);

    $token = bin2hex(random_bytes(32));
    $pdo->prepare('INSERT INTO sessions (token_hash, callsign, last_seen) VALUES (?, ?, ?)')
        ->execute([token_hash($token), $callsign, time()]);
    setcookie('cw_token', $token, cookie_options(time() + COOKIE_LIFETIME));
    return $callsign;
}

/** Gives a guest callsign a password. Other guests using it are signed out. */
function claim(string $callsign, string $password): void
{
    $pdo = db();
    if (find_account($callsign) !== null) {
        throw new ApiError(409, 'Already claimed');
    }
    if (strlen($password) < 8 || strlen($password) > 72) {
        throw new ApiError(400, 'Password must be 8-72 characters');
    }
    $accountCount = (int) $pdo->query('SELECT COUNT(*) FROM accounts')->fetchColumn();
    if ($accountCount >= MAX_ACCOUNTS) {
        throw new ApiError(503, 'No more accounts can be created');
    }

    $pdo->prepare('INSERT INTO accounts (callsign, password_hash) VALUES (?, ?)')
        ->execute([$callsign, password_hash($password, PASSWORD_DEFAULT)]);
    $pdo->prepare('DELETE FROM sessions WHERE callsign = ? AND token_hash != ?')
        ->execute([$callsign, token_hash((string) ($_COOKIE['cw_token'] ?? ''))]);
}


/** Ends the session on the server, so the callsign leaves the online list at once. */
function logout(): void
{
    $token = (string) ($_COOKIE['cw_token'] ?? '');
    db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([token_hash($token)]);
    setcookie('cw_token', '', cookie_options(time() - 3600));
}

