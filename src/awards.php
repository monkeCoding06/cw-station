<?php
declare(strict_types=1);

// Awards and the skins they unlock. Progress is counted from data we already keep
// (logbook, QSL cards, rig) plus a trainer counter. No message text or key timings.

// id => [title, how to earn it, counter, goal, [rig slot, skin]]
const ACHIEVEMENTS = [
    'licensed'  => ['Licensed', 'Claim your callsign', 'claimed', 1, ['knob', 'brass']],
    'first_log' => ['First entry', 'Write a logbook entry', 'log', 1, ['face', 'navy']],
    'contacts'  => ['Pen pals', 'Log 5 different stations', 'contacts', 5, ['dial', 'violet']],
    'qsl_sent'  => ['Card sender', 'Send a QSL card', 'qsl_sent', 1, ['meter', 'ivory']],
    'qsl_recv'  => ['Card collector', 'Receive a QSL card', 'qsl_recv', 1, ['knob', 'copper']],
    'tape'      => ['Personal touch', 'Put a tape caption on your rig', 'tape', 1, ['face', 'olive']],
    'train_25'  => ['Copy cadet', 'Copy 25 trainer characters', 'train', 25, ['dial', 'red']],
    'train_250' => ['Sharp ear', 'Copy 250 trainer characters', 'train', 250, ['face', 'carbon']],
    'train_1k'  => ['Iron ear', 'Copy 1000 trainer characters', 'train', 1000, ['knob', 'gold']],

    'contacts_10' => ['Regular', 'Log 10 different stations', 'contacts', 10, ['knob', 'blue']],
    'contacts_25' => ['Net control', 'Log 25 different stations', 'contacts', 25, ['face', 'maroon']],
    'contacts_50' => ['DXer', 'Log 50 different stations', 'contacts', 50, ['dial', 'white']],
    'log_10'      => ['Diarist', 'Write 10 logbook entries', 'log', 10, ['meter', 'mono']],
    'log_50'      => ['Chronicler', 'Write 50 logbook entries', 'log', 50, ['face', 'sand']],
    'log_100'     => ['Archivist', 'Write 100 logbook entries', 'log', 100, ['knob', 'titanium']],
    'qsl_sent_5'  => ['Postman', 'Send 5 QSL cards', 'qsl_sent', 5, ['dial', 'blue']],
    'qsl_sent_20' => ['Mailroom', 'Send 20 QSL cards', 'qsl_sent', 20, ['meter', 'sunset']],
    'qsl_recv_5'  => ['Popular', 'Receive 5 QSL cards', 'qsl_recv', 5, ['face', 'teal']],
    'qsl_recv_20' => ['Fan mail', 'Receive 20 QSL cards', 'qsl_recv', 20, ['knob', 'red']],
    'tape_3'      => ['Full house', 'Put 3 tape captions on your rig', 'tape', 3, ['knob', 'smoke']],
    'train_100'   => ['Steady fist', 'Copy 100 trainer characters', 'train', 100, ['dial', 'mint']],
    'train_500'   => ['Quick copy', 'Copy 500 trainer characters', 'train', 500, ['meter', 'night']],
    'train_2500'  => ['Grandmaster', 'Copy 2500 trainer characters', 'train', 2500, ['face', 'blueprint']],

    'log_25'       => ['Scribe', 'Write 25 logbook entries', 'log', 25, ['face', 'leather']],
    'contacts_15'  => ['Roundtable', 'Log 15 different stations', 'contacts', 15, ['face', 'walnut']],
    'qsl_sent_10'  => ['Stamp collector', 'Send 10 QSL cards', 'qsl_sent', 10, ['face', 'concrete']],
    'train_750'    => ['Rapid reader', 'Copy 750 trainer characters', 'train', 750, ['face', 'diamond']],
    'contacts_100' => ['Centurion', 'Log 100 different stations', 'contacts', 100, ['face', 'pcb']],
    'qsl_recv_10'  => ['Mailbox full', 'Receive 10 QSL cards', 'qsl_recv', 10, ['face', 'tartan']],
    'log_200'      => ['Historian', 'Write 200 logbook entries', 'log', 200, ['face', 'denim']],
    'train_50'     => ['Warm-up', 'Copy 50 trainer characters', 'train', 50, ['dial', 'lime']],
    'contacts_35'  => ['Band fixture', 'Log 35 different stations', 'contacts', 35, ['dial', 'cyan']],
    'qsl_recv_50'  => ['Celebrity', 'Receive 50 QSL cards', 'qsl_recv', 50, ['dial', 'rose']],
    'qsl_sent_50'  => ['Postmaster', 'Send 50 QSL cards', 'qsl_sent', 50, ['knob', 'rosegold']],
    'log_75'       => ['Keeper', 'Write 75 logbook entries', 'log', 75, ['knob', 'jade']],
    'train_5000'   => ['Living legend', 'Copy 5000 trainer characters', 'train', 5000, ['knob', 'onyx']],
    'log_150'      => ['Chart room', 'Write 150 logbook entries', 'log', 150, ['meter', 'forest']],
    'train_1500'   => ['Blazing copy', 'Copy 1500 trainer characters', 'train', 1500, ['meter', 'ruby']],
];

function award_counters(string $user): array
{
    $count = static function (string $sql) use ($user): int {
        $stmt = db()->prepare($sql);
        $stmt->execute([$user]);
        return (int) $stmt->fetchColumn();
    };
    return [
        'claimed'  => 1,
        'log'      => $count('SELECT COUNT(*) FROM log_entries WHERE callsign = ?'),
        'contacts' => $count("SELECT COUNT(DISTINCT upper(contact)) FROM log_entries WHERE callsign = ? AND contact != ''"),
        'qsl_sent' => $count('SELECT COUNT(*) FROM qsl_cards WHERE from_call = ?'),
        'qsl_recv' => $count('SELECT COUNT(*) FROM qsl_cards WHERE to_call = ?'),
        'tape'     => count(load_rig($user)['tapes'] ?? []),
        'train'    => $count('SELECT COALESCE(MAX(n), 0) FROM train_counts WHERE callsign = ?'),
    ];
}

// stores newly reached goals, returns their ids
function award_sync(string $user): array
{
    $stmt = db()->prepare('SELECT name FROM achievements WHERE callsign = ?');
    $stmt->execute([$user]);
    $have = $stmt->fetchAll(PDO::FETCH_COLUMN);
    $counters = award_counters($user);

    $fresh = [];
    foreach (ACHIEVEMENTS as $id => [, , $counter, $goal]) {
        if (!in_array($id, $have, true) && $counters[$counter] >= $goal) {
            db()->prepare('INSERT OR IGNORE INTO achievements (callsign, name, unlocked_at) VALUES (?, ?, ?)')
                ->execute([$user, $id, time()]);
            $fresh[] = $id;
        }
    }
    return $fresh;
}

// all awards with progress; guests get the bare list
function award_state(?string $user): array
{
    $unlocked = [];
    $counters = [];
    if ($user !== null) {
        $stmt = db()->prepare('SELECT name FROM achievements WHERE callsign = ?');
        $stmt->execute([$user]);
        $unlocked = $stmt->fetchAll(PDO::FETCH_COLUMN);
        $counters = award_counters($user);
    }
    $out = [];
    foreach (ACHIEVEMENTS as $id => [$title, $how, $counter, $goal, $skin]) {
        $out[] = [
            'id' => $id, 'title' => $title, 'how' => $how, 'goal' => $goal,
            'progress' => min($goal, $counters[$counter] ?? 0),
            'unlocked' => in_array($id, $unlocked, true),
            'skin' => $skin,
        ];
    }
    return $out;
}

// only earned awards are shown on someone else's profile
function award_unlocked(string $user): array
{
    return array_values(array_map(
        static fn(array $a): array => ['id' => $a['id'], 'title' => $a['title'], 'skin' => $a['skin']],
        array_filter(award_state($user), static fn(array $a): bool => $a['unlocked']),
    ));
}

// first locked skin the rig uses: [slot, skin, how to earn it], or null
function rig_locked_skin(string $user, array $rig): ?array
{
    $state = award_state($user);
    foreach ($state as $award) {
        [$slot, $value] = $award['skin'];
        if (!$award['unlocked'] && ($rig[$slot] ?? null) === $value) {
            return [$slot, $value, $award['how']];
        }
    }
    return null;
}

// max one per second so a script can't pump the counter
function award_train_copy(string $user): void
{
    $now = time();
    db()->prepare(
        'INSERT INTO train_counts (callsign, n, last_at) VALUES (?, 1, ?)
         ON CONFLICT(callsign) DO UPDATE SET n = n + 1, last_at = excluded.last_at
         WHERE train_counts.last_at < excluded.last_at'
    )->execute([$user, $now]);
}
