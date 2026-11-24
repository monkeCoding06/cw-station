<?php
declare(strict_types=1);

require __DIR__ . '/../src/bootstrap.php';

send_security_headers();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

/** Writes a JSON response and stops. */
function respond(array $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_THROW_ON_ERROR);
    exit;
}

/**
 * POST bodies must be JSON and carry a custom header. Browsers refuse to add
 * that header on cross-site requests without a CORS preflight (which we never
 * approve), so other websites cannot make a visitor's browser post here.
 */
function read_post_body(int $limit = MAX_BODY_BYTES): array
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        throw new ApiError(405, 'POST required');
    }
    $isJson = str_starts_with(strtolower($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json');
    if (!$isJson || ($_SERVER['HTTP_X_CW_REQUEST'] ?? '') !== '1') {
        throw new ApiError(400, 'Bad request');
    }

    $raw = file_get_contents('php://input', false, null, 0, $limit + 1);
    if ($raw === false || strlen($raw) > $limit) {
        throw new ApiError(413, 'Request too large');
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new ApiError(400, 'Invalid JSON');
    }
    return $data;
}

function require_user(): string
{
    $user = current_user();
    if ($user === null) {
        throw new ApiError(401, 'Not signed in');
    }
    return $user;
}

/** Checks a transmission: decoded text plus key-down/key-up durations in milliseconds. */
function validate_transmission(array $body): array
{
    $text = $body['text'] ?? '';
    if (!is_string($text) || preg_match('/^[A-Z0-9 .,?\/=+\-\x{25A1}]{0,120}$/u', $text) !== 1) {
        throw new ApiError(400, 'Invalid text');
    }

    // marks alternate key-down, key-up, key-down ... so the count is odd
    $marks = $body['marks'] ?? null;
    $valid = is_array($marks) && array_is_list($marks) && count($marks) >= 1
        && count($marks) <= 199 && count($marks) % 2 === 1;
    foreach ($valid ? $marks : [] as $ms) {
        $valid = $valid && is_int($ms) && $ms >= 1 && $ms <= 5000;
    }
    $lead = $body['lead'] ?? 0;
    if (!$valid || !is_int($lead) || $lead < 0 || $lead > 5000) {
        throw new ApiError(400, 'Invalid timing');
    }

    // frequency offset in Hz from 7.030 MHz, matching the tuning range of the rig
    $freq = $body['freq'] ?? 0;
    if (!is_int($freq) || $freq < -10000 || $freq > 10000) {
        throw new ApiError(400, 'Invalid frequency');
    }

    return ['text' => $text, 'marks' => $marks, 'lead' => $lead, 'freq' => $freq];
}

function handle_login(): never
{
    $body = read_post_body();
    $text = static fn(string $key): string => is_string($body[$key] ?? null) ? $body[$key] : '';
    $callsign = login($text('callsign'), $text('password'));
    respond(['callsign' => $callsign]);
}

function handle_claim(): never
{
    $body = read_post_body();
    $user = require_user();
    claim($user, is_string($body['password'] ?? null) ? $body['password'] : '');
    respond(['ok' => true]);
}

function handle_logout(): never
{
    read_post_body();
    logout();
    respond(['ok' => true]);
}

/** Heartbeat from every room, and "gone" when the page closes. */
function handle_ping(): never
{
    $body = read_post_body();
    $user = require_user();
    $activity = in_array($body['activity'] ?? null, ['general', 'echo', 'practice', 'training'], true) ? $body['activity'] : null;
    touch_session(($body['leave'] ?? false) === true ? 0 : time(), is_bool($body['listening'] ?? null) ? $body['listening'] : null, $activity);
    respond(['online' => online_callsigns(), 'qsl' => qsl_unseen_count($user)]);
}

/** Appearance of any operator's rig. Callsigns without a saved rig, and guests, get null (the default look). */
function handle_rig_get(): never
{
    require_user();
    $call = strtoupper(is_string($_GET['call'] ?? null) ? $_GET['call'] : '');
    if (preg_match(CALLSIGN_PATTERN, $call) !== 1) {
        throw new ApiError(400, 'Invalid callsign');
    }
    respond(['rig' => load_rig($call), 'awards' => award_unlocked($call)]);
}

function handle_rig_save(): never
{
    $body = read_post_body();
    $user = require_user();
    require_account($user);
    $rig = validate_rig($body['rig'] ?? null);
    award_sync($user);
    if (($locked = rig_locked_skin($user, $rig)) !== null) {
        throw new ApiError(403, 'Locked skin: ' . $locked[2]);
    }
    save_rig($user, $rig);
    respond(['ok' => true]);
}

// list of awards, with progress for signed-in users
function handle_awards(): never
{
    $user = require_user();
    if (find_account($user) === null) {
        respond(['awards' => award_state(null), 'new' => []]);
    }
    $fresh = award_sync($user);
    respond(['awards' => award_state($user), 'new' => $fresh]);
}

// one correct trainer copy
function handle_award_train(): never
{
    read_post_body();
    $user = require_user();
    require_account($user);
    award_train_copy($user);
    $fresh = award_sync($user);
    respond(['awards' => award_state($user), 'new' => $fresh]);
}

function handle_qsl_design_get(): never
{
    $user = require_user();
    $design = load_qsl_design($user);
    respond(['design' => $design ?? default_qsl_design(), 'saved' => $design !== null]);
}

function handle_qsl_design_save(): never
{
    $body = read_post_body();
    $user = require_user();
    require_account($user);
    $design = validate_qsl_design($body['design'] ?? null, $user);
    save_qsl_design($user, $design);
    respond(['design' => $design]);
}

function handle_qsl_image_upload(): never
{
    $body = read_post_body(262144);
    $user = require_user();
    require_account($user);
    respond(['image' => store_qsl_image($user, is_string($body['data'] ?? null) ? $body['data'] : '')]);
}

function handle_qsl_image(): never
{
    $user = require_user();
    $hash = is_string($_GET['id'] ?? null) ? $_GET['id'] : '';
    $ext = preg_match('/^[a-f0-9]{64}$/D', $hash) === 1 ? qsl_image_for($user, $hash) : null;
    $path = $ext === null ? '' : qsl_dir() . "/$hash.$ext";
    if ($ext === null || !is_file($path)) {
        throw new ApiError(404, 'No such image');
    }
    header('Content-Type: ' . ['jpg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp'][$ext]);
    header('Cache-Control: private, max-age=31536000, immutable');
    header('Content-Length: ' . filesize($path));
    readfile($path);
    exit;
}

function handle_qsl_send(): never
{
    $body = read_post_body();
    $user = require_user();
    $to = strtoupper(is_string($body['to'] ?? null) ? $body['to'] : '');
    respond(send_qsl($user, $to));
}

function handle_qsl_inbox(): never
{
    $user = require_user();
    respond(['cards' => qsl_inbox($user)]);
}

function handle_qsl_seen(): never
{
    read_post_body();
    $user = require_user();
    db()->prepare('UPDATE qsl_cards SET seen = 1 WHERE to_call = ?')->execute([$user]);
    respond(['ok' => true]);
}

function handle_qsl_delete(): never
{
    $body = read_post_body();
    $user = require_user();
    $id = $body['id'] ?? null;
    if (!is_int($id)) {
        throw new ApiError(400, 'Invalid card');
    }
    db()->prepare('DELETE FROM qsl_cards WHERE id = ? AND to_call = ?')->execute([$id, $user]);
    respond(['ok' => true]);
}

/** The server logbook belongs to claimed callsigns; guests keep theirs in the browser. */
function require_account(string $user): void
{
    if (find_account($user) === null) {
        throw new ApiError(403, 'Claim your callsign to keep the logbook on the server');
    }
}

function handle_log_list(): never
{
    $user = require_user();
    require_account($user);

    $stmt = db()->prepare(
        'SELECT id, logged_at, contact, body FROM log_entries WHERE callsign = ? ORDER BY id DESC LIMIT ' . MAX_LOG_ENTRIES
    );
    $stmt->execute([$user]);
    respond(['entries' => array_map(static fn(array $row): array => [
        'id' => (int) $row['id'],
        'at' => (int) $row['logged_at'],
        'contact' => $row['contact'],
        'text' => $row['body'],
    ], $stmt->fetchAll())]);
}

/** Adds an entry stamped with the server's clock. `at` is only honoured to carry over a guest logbook. */
function handle_log_add(): never
{
    $body = read_post_body();
    $user = require_user();
    require_account($user);
    $pdo = db();

    $contact = strtoupper(trim(is_string($body['contact'] ?? null) ? $body['contact'] : ''));
    $text = trim(is_string($body['text'] ?? null) ? $body['text'] : '');
    if (preg_match('/^[A-Z0-9\/]{0,12}$/', $contact) !== 1) {
        throw new ApiError(400, 'Invalid callsign');
    }
    if ($text === '' || mb_strlen($text) > MAX_LOG_CHARS) {
        throw new ApiError(400, 'An entry needs 1-' . MAX_LOG_CHARS . ' characters');
    }

    $now = time();
    $at = $body['at'] ?? $now;
    if (!is_int($at) || $at < 1 || $at > $now) {
        $at = $now;
    }

    $count = $pdo->prepare('SELECT COUNT(*) FROM log_entries WHERE callsign = ?');
    $count->execute([$user]);
    if ((int) $count->fetchColumn() >= MAX_LOG_ENTRIES) {
        throw new ApiError(409, 'The logbook is full');
    }

    $pdo->prepare('INSERT INTO log_entries (callsign, logged_at, contact, body) VALUES (?, ?, ?, ?)')
        ->execute([$user, $at, $contact, $text]);
    respond(['entry' => ['id' => (int) $pdo->lastInsertId(), 'at' => $at, 'contact' => $contact, 'text' => $text]]);
}

function handle_log_delete(): never
{
    $body = read_post_body();
    $user = require_user();
    require_account($user);
    $id = $body['id'] ?? null;
    if (!is_int($id)) {
        throw new ApiError(400, 'Invalid entry');
    }
    db()->prepare('DELETE FROM log_entries WHERE id = ? AND callsign = ?')->execute([$id, $user]);
    respond(['ok' => true]);
}

/** Dispatch validated, authenticated traffic to a channel-specific live subscription. */
function handle_live(string $channel, string $action): never
{
    $body = read_post_body();
    $user = require_user();
    $view = $body['view'] ?? null;
    if (!is_string($view) || !preg_match('/^[a-f0-9-]{36}$/D', $view)) {
        throw new ApiError(400, 'Invalid station view');
    }
    $request = ['channel' => $channel, 'action' => $action, 'call' => $user, 'view' => $view];
    if ($channel === 'cw' && $action === 'send') {
        $request['transmission'] = validate_transmission($body);
    } elseif ($action === 'send') {
        $text = trim(is_string($body['text'] ?? null) ? $body['text'] : '');
        if (!preg_match('/^[^\x00-\x1f\x7f]{1,200}$/uD', $text)) {
            throw new ApiError(400, 'A message needs 1-200 characters');
        }
        $request['text'] = $text;
    }

    $socket = @stream_socket_client('unix:///run/cw-chat.sock', $errno, $error, 2);
    if (!$socket) {
        throw new ApiError(503, 'Station relay is offline');
    }
    try {
        stream_set_timeout($socket, 3);
        fwrite($socket, json_encode($request, JSON_THROW_ON_ERROR) . "\n");
        $line = fgets($socket);
    } finally {
        fclose($socket);
    }
    if (!$line) {
        throw new ApiError(503, 'Station relay did not respond');
    }
    $reply = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
    if ($channel === 'cw' && $action === 'poll' && isset($reply['messages'])) {
        $reply['online'] = online_callsigns();
    }
    respond($reply, $reply['status'] ?? 200);
}

try {
    match ($_GET['action'] ?? '') {
        'chat_join' => handle_live('chat', 'join'),
        'chat_send' => handle_live('chat', 'send'),
        'chat_poll' => handle_live('chat', 'poll'),
        'chat_leave' => handle_live('chat', 'leave'),
        'login' => handle_login(),
        'logout' => handle_logout(),
        'ping' => handle_ping(),
        'log_list' => handle_log_list(),
        'log_add' => handle_log_add(),
        'log_delete' => handle_log_delete(),
        'claim' => handle_claim(),
        'rig_get' => handle_rig_get(),
        'rig_save' => handle_rig_save(),
        'awards' => handle_awards(),
        'award_train' => handle_award_train(),
        'qsl_design_get' => handle_qsl_design_get(),
        'qsl_design_save' => handle_qsl_design_save(),
        'qsl_image_upload' => handle_qsl_image_upload(),
        'qsl_image' => handle_qsl_image(),
        'qsl_send' => handle_qsl_send(),
        'qsl_inbox' => handle_qsl_inbox(),
        'qsl_seen' => handle_qsl_seen(),
        'qsl_delete' => handle_qsl_delete(),
        'cw_join' => handle_live('cw', 'join'),
        'cw_poll' => handle_live('cw', 'poll'),
        'cw_send' => handle_live('cw', 'send'),
        'cw_leave' => handle_live('cw', 'leave'),
        default => throw new ApiError(404, 'Unknown action'),
    };
} catch (ApiError $e) {
    respond(['error' => $e->getMessage()], $e->status);
} catch (Throwable $e) {
    error_log($e->getMessage());
    respond(['error' => 'Server error'], 500);
}
