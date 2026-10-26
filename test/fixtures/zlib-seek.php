<?php
$results = [];
foreach ([1, 8193, 32781] as $length) {
    $path = '/workspace/zero-seek-' . $length . '.gz';
    $output = gzopen($path, 'wb');
    if ($output === false || gzseek($output, $length, SEEK_SET) !== 0) {
        throw new RuntimeException('Unable to seek in an unwritten gzip stream');
    }
    // Exercise gzclose's pending forward seek before any gzwrite has occurred.
    if (!gzclose($output)) {
        throw new RuntimeException('Unable to close the unwritten gzip stream');
    }
    $input = gzopen($path, 'rb');
    if ($input === false) {
        throw new RuntimeException('Unable to reopen the gzip stream');
    }
    $data = '';
    while (!gzeof($input)) {
        $chunk = gzread($input, 8192);
        if ($chunk === false) {
            throw new RuntimeException('Unable to read the gzip stream');
        }
        $data .= $chunk;
    }
    gzclose($input);
    $results[] = ['length' => strlen($data), 'zero_filled' => $data === str_repeat("\0", $length)];
}
echo json_encode($results, JSON_THROW_ON_ERROR);
