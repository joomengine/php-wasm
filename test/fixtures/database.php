<?php
/** Real PHP WASM PDO -> asynchronous host call -> real MariaDB WASM. */
declare(strict_types=1);

$assertions = 0;
function same(mixed $expected, mixed $actual, string $message): void
{
    $GLOBALS['assertions']++;
    if ($expected !== $actual) {
        throw new RuntimeException($message . ': ' . var_export($actual, true));
    }
}

$db = new PDO('mysql:host=mariadb-wasm;dbname=joomla;charset=utf8mb4', 'root', '', [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$case = getenv('DATABASE_CASE') ?: 'contract';

if ($case === 'contract') {
    same(4, PHP_INT_SIZE, 'The integration executes wasm32 PHP');
    same(true, extension_loaded('pdo_mariadb_wasm'), 'The native PDO extension is compiled in');
    same(['mysql'], PDO::getAvailableDrivers(), 'PDO mysql uses the bridge');
    same(true, str_contains($db->getAttribute(PDO::ATTR_SERVER_VERSION), 'MariaDB'), 'Real MariaDB server');
    $db->exec('DROP TABLE IF EXISTS database_contract');
    $db->exec('CREATE TABLE database_contract (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        label VARCHAR(255) CHARACTER SET utf8mb4,
        payload LONGBLOB,
        big BIGINT UNSIGNED,
        amount DECIMAL(24,6),
        nullable VARCHAR(10) NULL
    ) ENGINE=InnoDB AUTO_INCREMENT=4294967296');
    $text = "Namibia 🐘 ' \\ \0 ; -- ? :parameter";
    $binary = implode('', array_map(chr(...), range(0, 255)));
    $statement = $db->prepare('INSERT INTO database_contract (label,payload,big,amount,nullable) VALUES (:label,:payload,:big,:amount,:nullable)');
    $statement->bindValue(':label', $text, PDO::PARAM_STR);
    $statement->bindValue(':payload', $binary, PDO::PARAM_LOB);
    $statement->bindValue(':big', '18446744073709551615', PDO::PARAM_STR);
    $statement->bindValue(':amount', '123456789012345678.123456', PDO::PARAM_STR);
    $statement->bindValue(':nullable', null, PDO::PARAM_NULL);
    $statement->execute();
    same(1, $statement->rowCount(), 'Inserted row count');
    same('4294967296', $db->lastInsertId(), 'Insert IDs survive wasm32 integer limits');
    unset($statement);
    $statement = $db->prepare('SELECT label,payload,big,amount,nullable FROM database_contract WHERE id=?');
    $statement->bindValue(1, '4294967296', PDO::PARAM_STR);
    $statement->execute();
    same(5, $statement->columnCount(), 'Column count');
    same([$text, $binary, '18446744073709551615', '123456789012345678.123456', null], $statement->fetch(PDO::FETCH_NUM), 'Lossless text, binary, numeric and null values');
    same(false, $statement->fetch(), 'Cursor exhaustion');
    same('label', $statement->getColumnMeta(0)['name'], 'Column metadata');
    $statement->closeCursor();
    unset($statement);

    $stream = fopen('php://memory', 'r+');
    fwrite($stream, $binary);
    rewind($stream);
    $statement = $db->prepare('INSERT INTO database_contract(label,payload) VALUES (?,?)');
    $statement->bindValue(1, 'stream', PDO::PARAM_STR);
    $statement->bindParam(2, $stream, PDO::PARAM_LOB);
    $statement->execute();
    same($binary, $db->query("SELECT payload FROM database_contract WHERE label='stream'")->fetchColumn(), 'LOB stream binding');
    if (is_resource($stream)) fclose($stream);
    unset($statement);

    $value = 'first';
    $statement = $db->prepare('UPDATE database_contract SET label=:label WHERE id=:id');
    $statement->bindParam(':label', $value, PDO::PARAM_STR);
    $statement->bindValue(':id', '4294967296', PDO::PARAM_STR);
    $statement->execute();
    $value = 'second';
    $statement->execute();
    same('second', $db->query('SELECT label FROM database_contract WHERE id=4294967296')->fetchColumn(), 'Repeated bind-by-reference execution');
    unset($statement);

    $db->beginTransaction();
    same(true, $db->inTransaction(), 'Transaction begins');
    $db->exec("INSERT INTO database_contract(label) VALUES ('rolled back')");
    $db->rollBack();
    same(false, $db->inTransaction(), 'Rollback clears transaction state');
    same('2', $db->query('SELECT COUNT(*) AS total FROM database_contract')->fetchColumn(), 'Rollback removes the inserted row');
    $db->beginTransaction();
    $db->exec("INSERT INTO database_contract(label) VALUES ('committed')");
    $db->commit();
    same('3', $db->query('SELECT COUNT(*) AS total FROM database_contract')->fetchColumn(), 'Commit persists the inserted row');
    $db->beginTransaction();
    $db->exec('CREATE TABLE IF NOT EXISTS database_implicit_commit (id INT) ENGINE=InnoDB');
    same(false, $db->inTransaction(), 'DDL implicit commit updates PDO state');

    try {
        $db->exec("INSERT INTO database_contract(id,label) VALUES (4294967296,'duplicate')");
        throw new RuntimeException('Expected duplicate-key failure');
    } catch (PDOException $error) {
        same('23000', $error->errorInfo[0], 'MariaDB SQLSTATE');
        same(1062, $error->errorInfo[1], 'MariaDB duplicate-key errno');
    }
    unset($error);
    same('3', $db->query('SELECT COUNT(*) AS total FROM database_contract')->fetchColumn(), 'PDO recovers after SQL errors');

    $db->exec("SET sql_mode='NO_BACKSLASH_ESCAPES'");
    $statement = $db->prepare('UPDATE database_contract SET label=:text WHERE id=:id');
    $statement->execute(['text' => "quoted' \\ text", 'id' => '4294967296']);
    same("quoted' \\ text", $db->query('SELECT label FROM database_contract WHERE id=4294967296')->fetchColumn(), 'The bridge restores a compatible quote mode');
    unset($statement);
    // Joomla Framework's MysqlDriver::escape() removes PDO::quote's delimiters.
    $value = "Joomla's \\ escaped 🐘 value";
    $escaped = substr($db->quote($value), 1, -1);
    $db->exec("UPDATE database_contract SET label='$escaped' WHERE id=4294967296");
    same($value, $db->query('SELECT label FROM database_contract WHERE id=4294967296')->fetchColumn(), 'Joomla quote-and-strip convention');
    echo json_encode(['assertions' => $assertions, 'integerSize' => PHP_INT_SIZE, 'server' => $db->getAttribute(PDO::ATTR_SERVER_VERSION)], JSON_THROW_ON_ERROR);
    // Leave $db alive: request shutdown must perform its asynchronous close.
    return;
}

$db->exec('CREATE TABLE IF NOT EXISTS request_rows (label VARCHAR(255) PRIMARY KEY) ENGINE=InnoDB');
if ($case === 'seed') {
    $db->exec('DELETE FROM request_rows');
    $db->exec("INSERT INTO request_rows VALUES ('committed')");
    echo 'seeded';
} elseif ($case === 'check') {
    echo json_encode($db->query('SELECT label FROM request_rows ORDER BY label')->fetchAll(PDO::FETCH_COLUMN), JSON_THROW_ON_ERROR);
} elseif (in_array($case, ['return', 'exit', 'fatal', 'timeout'], true)) {
    $db->beginTransaction();
    $statement = $db->prepare('INSERT INTO request_rows VALUES (?)');
    $statement->execute([$case]);
    unset($statement);
    if ($case === 'fatal') throw new RuntimeException('database fixture intentional fatal');
    if ($case === 'timeout') {
        // The parent must reset the abandoned database lease after terminating PHP.
        php_wasm_host_call('database.timeout-ready', '{}');
        while (true) {}
    }
    echo json_encode(['transaction' => $db->inTransaction()], JSON_THROW_ON_ERROR);
    if ($case === 'exit') exit(17);
} else {
    throw new RuntimeException('Unknown database fixture case: ' . $case);
}
