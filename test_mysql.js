const mysql = require('mysql2');

const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'ansh1234@@@'
});

connection.connect((err) => {
  if (err) {
    console.error('Error connecting: ' + err.stack);
    process.exit(1);
  }
  console.log('Connected to MySQL successfully.');
  process.exit(0);
});
