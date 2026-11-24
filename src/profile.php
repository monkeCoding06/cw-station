<?php
declare(strict_types=1);

/**
 * Operator appearance and QSL cards. Neither touches the live relay:
 * a rig is a small validated settings record, a QSL card is a snapshot
 * (callsigns, date and the sender's card design as it was when sent).
 */

const RIG_CHOICES = [
    'face' => ['matte', 'brushed', 'charcoal', 'vintage', 'navy', 'olive', 'carbon', 'maroon', 'sand', 'teal', 'blueprint'],
    'dial' => ['green', 'amber', 'ice', 'violet', 'red', 'white', 'blue', 'mint'],
    'knob' => ['black-silver', 'ribbed', 'bakelite', 'chrome', 'brass', 'copper', 'gold', 'blue', 'titanium', 'red', 'smoke'],
    'meter' => ['black', 'cream', 'amber', 'ivory', 'mono', 'sunset', 'night'],
];
const RIG_MAX_TAPES = 3;

const QSL_STYLES = ['plain', 'border', 'stripe'];
const QSL_IMAGE_MAX_BYTES = 150000;
const QSL_IMAGES_KEPT = 5;                  // per operator, besides images that cards or the design still use
const QSL_UPLOADS_PER_HOUR = 10;
const QSL_SENT_PER_DAY = 20;
const QSL_PER_RECIPIENT_PER_DAY = 3;
const QSL_INBOX_MAX = 200;

/* ---------- Rig appearance ---------- */

function default_rig(): array
{
    return [
        'face' => 'matte', 'dial' => 'green', 'knob' => 'ribbed', 'meter' => 'black',
        'backlight' => false, 'tapes' => [],
    ];
}

/** Returns a clean rig record or throws. Only known options and short plain captions get through. */
function validate_rig(mixed $input): array
{
    if (!is_array($input)) {
        throw new ApiError(400, 'Invalid rig');
    }
    $rig = default_rig();
    foreach (RIG_CHOICES as $key => $allowed) {
        $value = $input[$key] ?? null;
        if (!is_string($value) || !in_array($value, $allowed, true)) {
            throw new ApiError(400, 'Invalid rig option');
        }
        $rig[$key] = $value;
    }
    if (!is_bool($input['backlight'] ?? null)) {
        throw new ApiError(400, 'Invalid rig option');
    }
    $rig['backlight'] = $input['backlight'];

    $tapes = $input['tapes'] ?? [];
    if (!is_array($tapes) || !array_is_list($tapes)) {
        throw new ApiError(400, 'Invalid captions');
    }
    foreach (array_slice($tapes, 0, RIG_MAX_TAPES) as $tape) {
        $text = is_array($tape) ? ($tape['t'] ?? null) : null;
        $x = is_array($tape) ? ($tape['x'] ?? null) : null;
        $y = is_array($tape) ? ($tape['y'] ?? null) : null;
        $valid = is_string($text) && preg_match('/^[A-Za-z0-9 \/.,?!+\-]{1,10}$/D', $text) === 1
            && is_int($x) && $x >= 0 && $x <= 100 && is_int($y) && $y >= 0 && $y <= 100;
        if (!$valid) {
            throw new ApiError(400, 'Invalid captions');
        }
        $rig['tapes'][] = ['t' => $text, 'x' => $x, 'y' => $y];
    }
    return $rig;
}

function load_rig(string $callsign): ?array
{
    $stmt = db()->prepare('SELECT config FROM rig_profiles WHERE callsign = ?');
    $stmt->execute([$callsign]);
    $json = $stmt->fetchColumn();
    if ($json === false) {
        return null;
    }
    try {
        return validate_rig(json_decode((string) $json, true));
    } catch (Throwable) {
        return null;
    }
}

function save_rig(string $callsign, array $rig): void
{
    db()->prepare(
        'INSERT INTO rig_profiles (callsign, config, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(callsign) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at'
    )->execute([$callsign, json_encode($rig, JSON_THROW_ON_ERROR), time()]);
}

/** The data-* attributes the page puts on .bench, so a saved look is there before any script runs. */
function rig_attributes(array $rig): string
{
    $out = '';
    foreach (array_keys(RIG_CHOICES) as $key) {
        $out .= ' data-' . $key . '="' . $rig[$key] . '"';
    }
    return $out . ' data-backlight="' . ($rig['backlight'] ? 'true' : 'false') . '"';
}

/* ---------- QSL card design ---------- */

function default_qsl_design(): array
{
    return [
        'bg' => '#1b3a6b', 'ink' => '#f4efe0', 'accent' => '#d9a441',
        'style' => 'border', 'note' => '73', 'image' => null, 'dim' => 35,
    ];
}

function qsl_image_owned(string $owner, string $hash): bool
{
    $stmt = db()->prepare('SELECT 1 FROM qsl_images WHERE owner = ? AND hash = ?');
    $stmt->execute([$owner, $hash]);
    return $stmt->fetchColumn() !== false;
}

function validate_qsl_design(mixed $input, string $owner): array
{
    if (!is_array($input)) {
        throw new ApiError(400, 'Invalid card');
    }
    $design = default_qsl_design();
    foreach (['bg', 'ink', 'accent'] as $key) {
        $value = $input[$key] ?? null;
        if (!is_string($value) || preg_match('/^#[0-9a-f]{6}$/D', $value) !== 1) {
            throw new ApiError(400, 'Invalid card color');
        }
        $design[$key] = $value;
    }
    if (!in_array($input['style'] ?? null, QSL_STYLES, true)) {
        throw new ApiError(400, 'Invalid card style');
    }
    $design['style'] = $input['style'];

    $note = $input['note'] ?? '';
    if (!is_string($note) || preg_match('/^[^\x00-\x1f\x7f]{0,60}$/uD', $note) !== 1) {
        throw new ApiError(400, 'A card note is up to 60 characters');
    }
    $design['note'] = $note;

    $dim = $input['dim'] ?? null;
    if (!is_int($dim) || $dim < 0 || $dim > 80) {
        throw new ApiError(400, 'Invalid card shading');
    }
    $design['dim'] = $dim;

    $image = $input['image'] ?? null;
    if ($image !== null) {
        if (!is_string($image) || preg_match('/^[a-f0-9]{64}$/D', $image) !== 1 || !qsl_image_owned($owner, $image)) {
            throw new ApiError(400, 'Unknown card image');
        }
        $design['image'] = $image;
    }
    return $design;
}

function load_qsl_design(string $callsign): ?array
{
    $stmt = db()->prepare('SELECT design FROM qsl_designs WHERE callsign = ?');
    $stmt->execute([$callsign]);
    $json = $stmt->fetchColumn();
    if ($json === false) {
        return null;
    }
    try {
        return validate_qsl_design(json_decode((string) $json, true), $callsign);
    } catch (Throwable) {
        return null;
    }
}

function save_qsl_design(string $callsign, array $design): void
{
    db()->prepare(
        'INSERT INTO qsl_designs (callsign, design, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(callsign) DO UPDATE SET design = excluded.design, updated_at = excluded.updated_at'
    )->execute([$callsign, json_encode($design, JSON_THROW_ON_ERROR), time()]);
}

/* ---------- QSL background images ---------- */

function qsl_dir(): string
{
    $dir = DATA_DIR . '/qsl';
    if (!is_dir($dir) && !mkdir($dir, 0750, true) && !is_dir($dir)) {
        throw new RuntimeException('Cannot create QSL directory');
    }
    return $dir;
}

/** Keeps a JPEG, PNG or WebP upload under its content hash and returns the hash. */
function store_qsl_image(string $owner, string $base64): string
{
    $raw = base64_decode($base64, true);
    if ($raw === false || $raw === '') {
        throw new ApiError(400, 'Invalid image');
    }
    if (strlen($raw) > QSL_IMAGE_MAX_BYTES) {
        throw new ApiError(413, 'Image too large');
    }
    $info = @getimagesizefromstring($raw);
    $types = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'];
    if ($info === false || !isset($types[$info[2]]) || $info[0] < 32 || $info[1] < 32 || $info[0] > 2000 || $info[1] > 2000) {
        throw new ApiError(400, 'Use a JPEG, PNG or WebP image');
    }

    $pdo = db();
    $recent = $pdo->prepare('SELECT COUNT(*) FROM qsl_images WHERE owner = ? AND created_at > ?');
    $recent->execute([$owner, time() - 3600]);
    if ((int) $recent->fetchColumn() >= QSL_UPLOADS_PER_HOUR) {
        throw new ApiError(429, 'Too many uploads, try again later');
    }

    $hash = hash('sha256', $raw);
    $ext = $types[$info[2]];
    $path = qsl_dir() . "/$hash.$ext";
    if (!is_file($path)) {
        $tmp = tempnam(qsl_dir(), 'up');
        if ($tmp === false || file_put_contents($tmp, $raw) === false) {
            throw new RuntimeException('Cannot write QSL image');
        }
        chmod($tmp, 0640);
        rename($tmp, $path);
    }
    $pdo->prepare('INSERT OR IGNORE INTO qsl_images (owner, hash, ext, created_at) VALUES (?, ?, ?, ?)')
        ->execute([$owner, $hash, $ext, time()]);
    prune_qsl_images($owner);
    return $hash;
}

/** Drops an operator's oldest images, except those a sent card or the current design still shows. */
function prune_qsl_images(string $owner): void
{
    $pdo = db();
    $old = $pdo->prepare('SELECT hash FROM qsl_images WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ' . QSL_IMAGES_KEPT);
    $old->execute([$owner]);
    $design = load_qsl_design($owner);
    foreach ($old->fetchAll(PDO::FETCH_COLUMN) as $hash) {
        $used = $pdo->prepare('SELECT 1 FROM qsl_cards WHERE image_hash = ? LIMIT 1');
        $used->execute([$hash]);
        if ($used->fetchColumn() !== false || ($design['image'] ?? null) === $hash) {
            continue;
        }
        $pdo->prepare('DELETE FROM qsl_images WHERE owner = ? AND hash = ?')->execute([$owner, $hash]);
        $rest = $pdo->prepare('SELECT ext FROM qsl_images WHERE hash = ? LIMIT 1');
        $rest->execute([$hash]);
        if ($rest->fetchColumn() === false) {
            foreach (['jpg', 'png', 'webp'] as $ext) {
                @unlink(qsl_dir() . "/$hash.$ext");
            }
        }
    }
}

/** Extension of an image this operator may see: their own, or one on a card they sent or received. */
function qsl_image_for(string $user, string $hash): ?string
{
    $pdo = db();
    $ext = $pdo->prepare('SELECT ext FROM qsl_images WHERE hash = ? LIMIT 1');
    $ext->execute([$hash]);
    $found = $ext->fetchColumn();
    if ($found === false) {
        return null;
    }
    $allowed = $pdo->prepare(
        'SELECT 1 WHERE EXISTS (SELECT 1 FROM qsl_images WHERE owner = :u AND hash = :h)
            OR EXISTS (SELECT 1 FROM qsl_cards WHERE image_hash = :h AND (to_call = :u OR from_call = :u))'
    );
    $allowed->execute(['u' => $user, 'h' => $hash]);
    return $allowed->fetchColumn() === false ? null : (string) $found;
}

/* ---------- QSL cards ---------- */

function qsl_card_row(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'at' => (int) $row['sent_at'],
        'seen' => (int) $row['seen'] === 1,
        'card' => json_decode($row['card'], true),
    ];
}

/** Stores a snapshot of the sender's saved design. Later edits to the design do not change it. */
function send_qsl(string $from, string $to): array
{
    $pdo = db();    if (preg_match(CALLSIGN_PATTERN, $to) !== 1 || $to === $from) {
        throw new ApiError(400, 'Choose another station');
    }
    if (find_account($from) === null) {
        throw new ApiError(403, 'Claim your callsign to send QSL cards');
    }
    if (find_account($to) === null) {
        throw new ApiError(404, 'That station has not claimed its callsign, so it cannot receive cards');
    }

    $now = time();
    $sent = $pdo->prepare('SELECT COUNT(*), COALESCE(SUM(to_call = ?), 0) FROM qsl_cards WHERE from_call = ? AND sent_at > ?');
    $sent->execute([$to, $from, $now - 86400]);
    [$total, $toThem] = array_map('intval', $sent->fetch(PDO::FETCH_NUM));
    if ($total >= QSL_SENT_PER_DAY || $toThem >= QSL_PER_RECIPIENT_PER_DAY) {
        throw new ApiError(429, 'You have sent enough cards for today');
    }
    $inbox = $pdo->prepare('SELECT COUNT(*) FROM qsl_cards WHERE to_call = ?');
    $inbox->execute([$to]);
    if ((int) $inbox->fetchColumn() >= QSL_INBOX_MAX) {
        throw new ApiError(409, 'Their card box is full');
    }

    $design = load_qsl_design($from) ?? default_qsl_design();
    $card = ['from' => $from, 'to' => $to, 'date' => gmdate('Y-m-d', $now), 'design' => $design];
    $pdo->prepare('INSERT INTO qsl_cards (from_call, to_call, sent_at, image_hash, card) VALUES (?, ?, ?, ?, ?)')
        ->execute([$from, $to, $now, $design['image'], json_encode($card, JSON_THROW_ON_ERROR)]);
    return ['id' => (int) $pdo->lastInsertId(), 'card' => $card];
}

function qsl_inbox(string $user): array
{
    $stmt = db()->prepare('SELECT id, sent_at, seen, card FROM qsl_cards WHERE to_call = ? ORDER BY id DESC LIMIT ' . QSL_INBOX_MAX);
    $stmt->execute([$user]);
    return array_map('qsl_card_row', $stmt->fetchAll());
}

function qsl_unseen_count(string $user): int
{
    $stmt = db()->prepare('SELECT COUNT(*) FROM qsl_cards WHERE to_call = ? AND seen = 0');
    $stmt->execute([$user]);
    return (int) $stmt->fetchColumn();
}
