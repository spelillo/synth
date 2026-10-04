// learn-datasets.js — every table the Learn courses query.
//
// Two kinds of dataset live here:
//   1. The three practice CSVs already shipped in /sample-data (the same
//      files the home page's sample-dataset cards load). They're fetched
//      at lesson load and given real column types, so SUM()/AVG() and
//      numeric comparisons behave the way a lesson says they will.
//   2. A small relational "Page Turner Books" store (authors, books,
//      customers, orders, order_items, employees, departments, formats,
//      subscriptions) plus monthly_sales, defined inline below. These
//      are deliberately small, so a learner can eyeball a join's output
//      and see exactly which rows matched, and they contain the edge
//      cases the intermediate and advanced lessons are built around:
//        - authors 9 and 13 have no books        (LEFT / FULL OUTER JOIN)
//        - book 24 has no author (anthology)     (RIGHT / FULL OUTER JOIN)
//        - books 15 and 20 were never ordered    (NOT EXISTS / anti-join)
//        - customers 8, 12, 15, 17, 20 never ordered
//        - orders 1018 and 1034 are guest checkouts with no customer
//        - employee 18 has no department; department 6 has no employees
//        - salary and price ties                 (RANK vs DENSE_RANK)
//        - employees.manager_id                  (self join, recursive CTE)
//
// Lessons grade by comparing result sets, so changing a row here changes
// the expected answer of every lesson that reads it. `npm test` re-runs
// every lesson's reference solution against this data and will flag it.
//
// Works as a plain browser global (window.LearnDatasets) and as a
// CommonJS module (for the Node test suite) — same pattern as the other
// learn-*.js files.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LearnDatasets = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DATASETS = {
    // ---- Practice CSVs (sample-data/) ----
    nfl_team_stats: {
      title: 'NFL team stats',
      description: 'One row per team per season, 2019 to 2023. Synthetic, built to match real NFL team and division structure.',
      csv: 'sample-data/nfl_team_stats.csv',
      columns: [
        { name: 'team', type: 'TEXT', desc: 'Full team name, e.g. "Buffalo Bills"' },
        { name: 'season', type: 'INTEGER', desc: 'Season year' },
        { name: 'conference', type: 'TEXT', desc: '"AFC" or "NFC"' },
        { name: 'division', type: 'TEXT', desc: '"East", "North", "South", or "West"' },
        { name: 'wins', type: 'INTEGER', desc: 'Regular season wins' },
        { name: 'losses', type: 'INTEGER', desc: 'Regular season losses' },
        { name: 'ties', type: 'INTEGER', desc: 'Regular season ties' },
        { name: 'points_for', type: 'INTEGER', desc: 'Points scored that season' },
        { name: 'points_against', type: 'INTEGER', desc: 'Points allowed that season' },
        { name: 'point_differential', type: 'INTEGER', desc: 'points_for minus points_against' },
        { name: 'made_playoffs', type: 'TEXT', desc: '"Yes" or "No"' },
      ],
    },
    bank_statement: {
      title: 'Bank statement',
      description: 'Six months of checking account activity, January to June 2025. Synthetic.',
      csv: 'sample-data/bank_statement.csv',
      columns: [
        { name: 'transaction_id', type: 'TEXT', desc: 'Unique ID, e.g. "TXN1001"' },
        { name: 'date', type: 'TEXT', desc: 'Transaction date, YYYY-MM-DD' },
        { name: 'description', type: 'TEXT', desc: 'Merchant or payer' },
        { name: 'category', type: 'TEXT', desc: 'e.g. Groceries, Rent, Dining Out, Paycheck' },
        { name: 'type', type: 'TEXT', desc: '"credit" (money in) or "debit" (money out)' },
        { name: 'amount', type: 'REAL', desc: 'Always positive' },
        { name: 'balance_after', type: 'REAL', desc: 'Balance right after this transaction' },
      ],
    },
    grocery_store_data: {
      title: 'Grocery store sales',
      description: 'A month of grocery sales (March 2025) across departments and five store locations. Synthetic.',
      csv: 'sample-data/grocery_store_data.csv',
      columns: [
        { name: 'product_id', type: 'TEXT', desc: 'Product ID, e.g. "P127"' },
        { name: 'product_name', type: 'TEXT', desc: 'e.g. "Bananas", "Whole Milk"' },
        { name: 'category', type: 'TEXT', desc: 'Department, e.g. Produce, Dairy, Bakery' },
        { name: 'unit', type: 'TEXT', desc: 'Sale unit, e.g. "lb", "dozen"' },
        { name: 'unit_price', type: 'REAL', desc: 'Price per unit in dollars' },
        { name: 'store_location', type: 'TEXT', desc: 'One of 5 store locations' },
        { name: 'date', type: 'TEXT', desc: 'Date of sale, YYYY-MM-DD' },
        { name: 'quantity_sold', type: 'INTEGER', desc: 'Units sold' },
        { name: 'revenue', type: 'REAL', desc: 'quantity_sold times unit_price' },
      ],
    },

    // ---- Page Turner Books (inline) ----
    authors: {
      title: 'Authors',
      description: 'Authors in the Page Turner Books catalog. Two of them have no books in stock yet.',
      columns: [
        { name: 'author_id', type: 'INTEGER', desc: 'Primary key', pk: true },
        { name: 'name', type: 'TEXT', desc: 'Author name' },
        { name: 'country', type: 'TEXT', desc: 'Country of birth' },
        { name: 'birth_year', type: 'INTEGER', desc: 'Year of birth' },
      ],
      rows: [
        [1, 'Octavia E. Butler', 'United States', 1947],
        [2, 'Ursula K. Le Guin', 'United States', 1929],
        [3, 'Kazuo Ishiguro', 'United Kingdom', 1954],
        [4, 'Chimamanda Ngozi Adichie', 'Nigeria', 1977],
        [5, 'Haruki Murakami', 'Japan', 1949],
        [6, 'Zadie Smith', 'United Kingdom', 1975],
        [7, 'Gabriel García Márquez', 'Colombia', 1927],
        [8, 'Agatha Christie', 'United Kingdom', 1890],
        [9, 'N. K. Jemisin', 'United States', 1972],
        [10, 'Ted Chiang', 'United States', 1967],
        [11, 'Elena Ferrante', 'Italy', 1943],
        [12, 'Liu Cixin', 'China', 1963],
        [13, 'Mohsin Hamid', 'Pakistan', 1971],
      ],
    },
    books: {
      title: 'Books',
      description: 'The store catalog. Titles are real; prices and page counts are illustrative. Book 24 is an anthology with no single author.',
      columns: [
        { name: 'book_id', type: 'INTEGER', desc: 'Primary key', pk: true },
        { name: 'title', type: 'TEXT', desc: 'Book title' },
        { name: 'author_id', type: 'INTEGER', desc: 'Foreign key to authors.author_id (NULL for the anthology)', fk: 'authors.author_id' },
        { name: 'genre', type: 'TEXT', desc: 'Science Fiction, Fantasy, Literary Fiction, Mystery, or Anthology' },
        { name: 'published_year', type: 'INTEGER', desc: 'Year first published' },
        { name: 'price', type: 'REAL', desc: 'List price in dollars' },
        { name: 'pages', type: 'INTEGER', desc: 'Page count' },
      ],
      rows: [
        [1, 'Kindred', 1, 'Science Fiction', 1979, 15.99, 264],
        [2, 'Parable of the Sower', 1, 'Science Fiction', 1993, 16.99, 345],
        [3, 'The Left Hand of Darkness', 2, 'Science Fiction', 1969, 17.50, 304],
        [4, 'A Wizard of Earthsea', 2, 'Fantasy', 1968, 12.99, 183],
        [5, 'The Dispossessed', 2, 'Science Fiction', 1974, 17.50, 387],
        [6, 'Never Let Me Go', 3, 'Literary Fiction', 2005, 16.00, 288],
        [7, 'The Remains of the Day', 3, 'Literary Fiction', 1989, 15.00, 245],
        [8, 'Klara and the Sun', 3, 'Science Fiction', 2021, 28.00, 303],
        [9, 'Americanah', 4, 'Literary Fiction', 2013, 18.00, 588],
        [10, 'Half of a Yellow Sun', 4, 'Literary Fiction', 2006, 17.00, 433],
        [11, 'Norwegian Wood', 5, 'Literary Fiction', 1987, 16.95, 296],
        [12, 'Kafka on the Shore', 5, 'Fantasy', 2002, 18.95, 467],
        [13, '1Q84', 5, 'Fantasy', 2009, 24.95, 925],
        [14, 'White Teeth', 6, 'Literary Fiction', 2000, 17.00, 448],
        [15, 'On Beauty', 6, 'Literary Fiction', 2005, 17.00, 445],
        [16, 'One Hundred Years of Solitude', 7, 'Literary Fiction', 1967, 17.99, 417],
        [17, 'Love in the Time of Cholera', 7, 'Literary Fiction', 1985, 16.99, 348],
        [18, 'Murder on the Orient Express', 8, 'Mystery', 1934, 12.99, 256],
        [19, 'And Then There Were None', 8, 'Mystery', 1939, 12.99, 264],
        [20, 'The Murder of Roger Ackroyd', 8, 'Mystery', 1926, 11.99, 312],
        [21, 'Stories of Your Life and Others', 10, 'Science Fiction', 2002, 16.00, 281],
        [22, 'My Brilliant Friend', 11, 'Literary Fiction', 2011, 18.00, 331],
        [23, 'The Three-Body Problem', 12, 'Science Fiction', 2008, 19.99, 400],
        [24, 'Best Short Stories of the Year', null, 'Anthology', 2024, 21.00, 380],
      ],
    },
    customers: {
      title: 'Customers',
      description: 'Store customers. referred_by points at the customer who referred them (NULL if nobody did).',
      columns: [
        { name: 'customer_id', type: 'INTEGER', desc: 'Primary key', pk: true },
        { name: 'first_name', type: 'TEXT', desc: 'First name' },
        { name: 'last_name', type: 'TEXT', desc: 'Last name' },
        { name: 'city', type: 'TEXT', desc: 'City' },
        { name: 'state', type: 'TEXT', desc: 'Two-letter state code' },
        { name: 'signup_date', type: 'TEXT', desc: 'Account creation date, YYYY-MM-DD' },
        { name: 'referred_by', type: 'INTEGER', desc: 'customer_id of the referrer, or NULL', fk: 'customers.customer_id' },
      ],
      rows: [
        [1, 'Maya', 'Patel', 'Portland', 'OR', '2024-01-15', null],
        [2, 'Jordan', 'Lee', 'Seattle', 'WA', '2024-01-22', 1],
        [3, 'Sofia', 'Garcia', 'Austin', 'TX', '2024-02-03', null],
        [4, 'Liam', "O'Brien", 'Boston', 'MA', '2024-02-10', null],
        [5, 'Ava', 'Chen', 'Seattle', 'WA', '2024-02-18', 2],
        [6, 'Noah', 'Williams', 'Chicago', 'IL', '2024-03-05', null],
        [7, 'Emma', 'Johnson', 'Denver', 'CO', '2024-03-12', 3],
        [8, 'Lucas', 'Martin', 'Portland', 'OR', '2024-03-20', 1],
        [9, 'Zoe', 'Kim', 'Austin', 'TX', '2024-04-02', null],
        [10, 'Ethan', 'Brown', 'Chicago', 'IL', '2024-04-15', 6],
        [11, 'Isabella', 'Rossi', 'Boston', 'MA', '2024-05-01', 4],
        [12, 'Mason', 'Davis', 'Denver', 'CO', '2024-05-09', null],
        [13, 'Mia', 'Thompson', 'Seattle', 'WA', '2024-05-21', 5],
        [14, 'Elijah', 'Clark', 'Austin', 'TX', '2024-06-03', 9],
        [15, 'Harper', 'Lewis', 'Portland', 'OR', '2024-06-18', null],
        [16, 'Aiden', 'Walker', 'Chicago', 'IL', '2024-07-07', 10],
        [17, 'Chloe', 'Hall', 'Denver', 'CO', '2024-07-19', null],
        [18, 'Daniel', 'Young', 'Boston', 'MA', '2024-08-02', 11],
        [19, 'Grace', 'Allen', 'Seattle', 'WA', '2024-08-25', 13],
        [20, 'Henry', 'Wright', 'Austin', 'TX', '2024-09-10', null],
      ],
    },
    orders: {
      title: 'Orders',
      description: 'One row per order, February to December 2024. customer_id is NULL for guest checkouts.',
      columns: [
        { name: 'order_id', type: 'INTEGER', desc: 'Primary key', pk: true },
        { name: 'customer_id', type: 'INTEGER', desc: 'Foreign key to customers.customer_id (NULL = guest checkout)', fk: 'customers.customer_id' },
        { name: 'order_date', type: 'TEXT', desc: 'Date placed, YYYY-MM-DD' },
        { name: 'status', type: 'TEXT', desc: 'delivered, shipped, processing, cancelled, or returned' },
      ],
      rows: [
        [1001, 14, '2024-02-04', 'delivered'],
        [1002, 5, '2024-02-11', 'delivered'],
        [1003, 9, '2024-02-15', 'delivered'],
        [1004, 11, '2024-02-23', 'delivered'],
        [1005, 9, '2024-02-29', 'delivered'],
        [1006, 10, '2024-03-11', 'delivered'],
        [1007, 18, '2024-03-16', 'delivered'],
        [1008, 19, '2024-03-24', 'delivered'],
        [1009, 5, '2024-03-29', 'cancelled'],
        [1010, 1, '2024-04-05', 'delivered'],
        [1011, 9, '2024-04-12', 'delivered'],
        [1012, 16, '2024-04-20', 'delivered'],
        [1013, 3, '2024-04-24', 'delivered'],
        [1014, 19, '2024-05-03', 'delivered'],
        [1015, 4, '2024-05-11', 'delivered'],
        [1016, 5, '2024-05-18', 'cancelled'],
        [1017, 1, '2024-05-26', 'delivered'],
        [1018, null, '2024-06-01', 'delivered'],
        [1019, 1, '2024-06-08', 'delivered'],
        [1020, 3, '2024-06-13', 'delivered'],
        [1021, 1, '2024-06-24', 'returned'],
        [1022, 6, '2024-06-30', 'delivered'],
        [1023, 11, '2024-07-06', 'delivered'],
        [1024, 3, '2024-07-13', 'returned'],
        [1025, 19, '2024-07-19', 'delivered'],
        [1026, 11, '2024-07-25', 'delivered'],
        [1027, 18, '2024-08-01', 'delivered'],
        [1028, 2, '2024-08-08', 'delivered'],
        [1029, 19, '2024-08-17', 'delivered'],
        [1030, 19, '2024-08-23', 'delivered'],
        [1031, 11, '2024-08-29', 'delivered'],
        [1032, 11, '2024-09-05', 'delivered'],
        [1033, 9, '2024-09-12', 'delivered'],
        [1034, null, '2024-09-18', 'delivered'],
        [1035, 3, '2024-09-28', 'delivered'],
        [1036, 7, '2024-10-05', 'cancelled'],
        [1037, 3, '2024-10-13', 'delivered'],
        [1038, 19, '2024-10-17', 'delivered'],
        [1039, 13, '2024-10-24', 'delivered'],
        [1040, 3, '2024-11-02', 'delivered'],
        [1041, 5, '2024-11-08', 'delivered'],
        [1042, 7, '2024-11-14', 'delivered'],
        [1043, 1, '2024-11-19', 'processing'],
        [1044, 9, '2024-11-28', 'shipped'],
        [1045, 10, '2024-12-07', 'shipped'],
        [1046, 13, '2024-12-11', 'processing'],
      ],
    },
    order_items: {
      title: 'Order items',
      description: 'The books in each order. One row per book per order; unit_price is what the customer paid per copy.',
      columns: [
        { name: 'order_id', type: 'INTEGER', desc: 'Foreign key to orders.order_id', fk: 'orders.order_id' },
        { name: 'book_id', type: 'INTEGER', desc: 'Foreign key to books.book_id', fk: 'books.book_id' },
        { name: 'quantity', type: 'INTEGER', desc: 'Copies bought' },
        { name: 'unit_price', type: 'REAL', desc: 'Price paid per copy' },
      ],
      rows: [
        [1001, 7, 1, 15.00],
        [1002, 12, 1, 18.95],
        [1003, 11, 2, 16.95],
        [1003, 6, 1, 16.00],
        [1004, 10, 1, 17.00],
        [1004, 3, 1, 17.50],
        [1005, 1, 1, 15.99],
        [1006, 7, 1, 15.00],
        [1006, 14, 1, 17.00],
        [1006, 10, 2, 17.00],
        [1007, 10, 1, 17.00],
        [1008, 6, 1, 16.00],
        [1009, 8, 1, 28.00],
        [1009, 6, 1, 16.00],
        [1010, 5, 1, 17.50],
        [1011, 23, 1, 19.99],
        [1012, 24, 1, 21.00],
        [1012, 14, 1, 17.00],
        [1013, 1, 1, 15.99],
        [1014, 12, 2, 18.95],
        [1015, 16, 1, 17.99],
        [1015, 4, 1, 12.99],
        [1015, 8, 1, 28.00],
        [1016, 12, 2, 18.95],
        [1016, 13, 1, 24.95],
        [1016, 4, 2, 12.99],
        [1017, 11, 1, 16.95],
        [1017, 4, 1, 12.99],
        [1018, 17, 2, 16.99],
        [1019, 24, 1, 21.00],
        [1019, 19, 1, 12.99],
        [1019, 14, 1, 17.00],
        [1020, 9, 1, 18.00],
        [1020, 2, 1, 16.99],
        [1021, 1, 1, 15.99],
        [1022, 7, 1, 15.00],
        [1022, 9, 1, 18.00],
        [1023, 9, 1, 18.00],
        [1024, 4, 1, 12.99],
        [1024, 6, 1, 16.00],
        [1024, 24, 1, 21.00],
        [1025, 19, 1, 12.99],
        [1025, 18, 1, 12.99],
        [1026, 12, 1, 18.95],
        [1026, 17, 1, 16.99],
        [1027, 13, 3, 24.95],
        [1027, 18, 1, 12.99],
        [1028, 4, 1, 12.99],
        [1028, 11, 2, 16.95],
        [1029, 2, 1, 16.99],
        [1030, 17, 1, 16.99],
        [1030, 23, 1, 19.99],
        [1031, 22, 1, 18.00],
        [1031, 21, 1, 16.00],
        [1032, 4, 3, 12.99],
        [1033, 14, 1, 17.00],
        [1033, 6, 1, 16.00],
        [1034, 16, 2, 17.99],
        [1034, 2, 1, 16.99],
        [1034, 1, 1, 15.99],
        [1035, 4, 2, 12.99],
        [1036, 16, 2, 17.99],
        [1036, 12, 3, 18.95],
        [1037, 1, 1, 15.99],
        [1038, 24, 1, 21.00],
        [1038, 21, 1, 16.00],
        [1039, 2, 1, 16.99],
        [1040, 8, 1, 28.00],
        [1040, 7, 1, 15.00],
        [1041, 2, 1, 16.99],
        [1041, 24, 1, 21.00],
        [1042, 22, 1, 18.00],
        [1042, 19, 2, 12.99],
        [1042, 7, 2, 15.00],
        [1043, 2, 1, 16.99],
        [1043, 4, 1, 12.99],
        [1044, 3, 1, 17.50],
        [1045, 21, 1, 16.00],
        [1045, 1, 1, 15.99],
        [1045, 3, 1, 17.50],
        [1046, 21, 2, 16.00],
        [1046, 4, 1, 12.99],
        [1046, 23, 1, 19.99],
      ],
    },
    formats: {
      title: 'Formats',
      description: 'The formats every book could be sold in.',
      columns: [
        { name: 'format_id', type: 'INTEGER', desc: 'Primary key', pk: true },
        { name: 'format', type: 'TEXT', desc: 'Format name' },
      ],
      rows: [
        [1, 'Hardcover'],
        [2, 'Paperback'],
        [3, 'Ebook'],
        [4, 'Audiobook'],
      ],
    },
    departments: {
      title: 'Departments',
      description: 'Page Turner Books company departments. Research has no employees yet.',
      columns: [
        { name: 'department_id', type: 'INTEGER', desc: 'Primary key', pk: true },
        { name: 'name', type: 'TEXT', desc: 'Department name' },
        { name: 'location', type: 'TEXT', desc: 'Office city' },
        { name: 'budget', type: 'INTEGER', desc: 'Annual budget in dollars' },
      ],
      rows: [
        [1, 'Sales', 'Portland', 250000],
        [2, 'Marketing', 'Seattle', 180000],
        [3, 'Engineering', 'Austin', 520000],
        [4, 'Operations', 'Portland', 210000],
        [5, 'Customer Support', 'Denver', 150000],
        [6, 'Research', 'Boston', 300000],
      ],
    },
    employees: {
      title: 'Employees',
      description: 'Company staff. manager_id points at another employee; the CEO has none. The intern has no department yet.',
      columns: [
        { name: 'employee_id', type: 'INTEGER', desc: 'Primary key', pk: true },
        { name: 'first_name', type: 'TEXT', desc: 'First name' },
        { name: 'last_name', type: 'TEXT', desc: 'Last name' },
        { name: 'title', type: 'TEXT', desc: 'Job title' },
        { name: 'department_id', type: 'INTEGER', desc: 'Foreign key to departments.department_id (NULL = unassigned)', fk: 'departments.department_id' },
        { name: 'manager_id', type: 'INTEGER', desc: 'employee_id of their manager (NULL for the CEO)', fk: 'employees.employee_id' },
        { name: 'hire_date', type: 'TEXT', desc: 'Start date, YYYY-MM-DD' },
        { name: 'salary', type: 'INTEGER', desc: 'Annual salary in dollars' },
      ],
      rows: [
        [1, 'Rosa', 'Alvarez', 'CEO', 4, null, '2015-03-01', 250000],
        [2, 'Ken', 'Okafor', 'VP of Sales', 1, 1, '2016-06-15', 165000],
        [3, 'Priya', 'Raman', 'VP of Engineering', 3, 1, '2016-09-01', 185000],
        [4, 'Tom', 'Becker', 'Marketing Director', 2, 1, '2017-02-20', 140000],
        [5, 'Lena', 'Fischer', 'Sales Manager', 1, 2, '2018-04-10', 98000],
        [6, 'Omar', 'Haddad', 'Account Executive', 1, 5, '2019-07-22', 72000],
        [7, 'Julia', 'Novak', 'Account Executive', 1, 5, '2020-01-13', 72000],
        [8, 'Sam', 'Rivera', 'Senior Engineer', 3, 3, '2018-11-05', 145000],
        [9, 'Aisha', 'Bello', 'Software Engineer', 3, 8, '2021-03-15', 118000],
        [10, 'Chen', 'Wei', 'Software Engineer', 3, 8, '2021-08-30', 118000],
        [11, 'Marta', 'Silva', 'Data Analyst', 3, 3, '2022-05-16', 95000],
        [12, 'Grace', 'Park', 'Marketing Specialist', 2, 4, '2020-10-01', 68000],
        [13, 'Diego', 'Morales', 'Content Writer', 2, 4, '2022-02-14', 61000],
        [14, 'Hannah', 'Scott', 'Operations Manager', 4, 1, '2017-08-08', 105000],
        [15, 'Ivan', 'Petrov', 'Support Lead', 5, 14, '2019-05-27', 70000],
        [16, 'Nora', 'Quinn', 'Support Specialist', 5, 15, '2023-01-09', 52000],
        [17, 'Felix', 'Grant', 'Support Specialist', 5, 15, '2023-06-19', 52000],
        [18, 'Kai', 'Moreno', 'Engineering Intern', null, 3, '2025-06-02', 38000],
      ],
    },
    subscriptions: {
      title: 'Subscriptions',
      description: 'The store\'s monthly book-box subscriptions. end_date is NULL while a subscription is still active.',
      columns: [
        { name: 'subscription_id', type: 'INTEGER', desc: 'Primary key', pk: true },
        { name: 'customer_id', type: 'INTEGER', desc: 'Foreign key to customers.customer_id', fk: 'customers.customer_id' },
        { name: 'plan', type: 'TEXT', desc: 'Basic, Plus, or Premium' },
        { name: 'monthly_price', type: 'INTEGER', desc: 'Price per month in dollars' },
        { name: 'start_date', type: 'TEXT', desc: 'YYYY-MM-DD' },
        { name: 'end_date', type: 'TEXT', desc: 'YYYY-MM-DD, or NULL if still active' },
      ],
      rows: [
        [1, 1, 'Premium', 25, '2024-06-29', '2024-08-13'],
        [2, 2, 'Plus', 15, '2024-04-29', '2024-09-28'],
        [3, 3, 'Plus', 15, '2024-03-09', null],
        [4, 4, 'Plus', 15, '2024-06-16', '2024-08-15'],
        [5, 5, 'Basic', 9, '2024-08-10', null],
        [6, 6, 'Premium', 25, '2024-05-23', '2024-08-12'],
        [7, 7, 'Premium', 25, '2024-06-25', null],
        [8, 8, 'Plus', 15, '2024-10-14', null],
        [9, 9, 'Basic', 9, '2024-03-21', '2024-09-23'],
        [10, 10, 'Premium', 25, '2024-03-30', null],
        [11, 11, 'Basic', 9, '2024-08-12', '2024-11-02'],
        [12, 12, 'Premium', 25, '2024-06-07', null],
        [13, 13, 'Premium', 25, '2024-07-31', null],
        [14, 14, 'Premium', 25, '2024-01-27', null],
        [15, 15, 'Basic', 9, '2024-03-06', null],
        [16, 16, 'Basic', 9, '2024-06-24', null],
        [17, 17, 'Plus', 15, '2024-06-25', null],
        [18, 18, 'Basic', 9, '2024-05-30', null],
        [19, 19, 'Plus', 15, '2024-06-10', null],
        [20, 20, 'Basic', 9, '2024-10-14', null],
        [21, 1, 'Plus', 15, '2024-08-14', null],
        [22, 2, 'Basic', 9, '2024-11-16', null],
        [23, 4, 'Basic', 9, '2024-10-20', null],
        [24, 9, 'Plus', 15, '2024-10-05', null],
        [25, 6, 'Premium', 25, '2024-09-02', null],
      ],
    },
    monthly_sales: {
      title: 'Monthly sales',
      description: 'Page Turner Books revenue and order counts by sales region and month for 2024.',
      columns: [
        { name: 'month', type: 'TEXT', desc: 'YYYY-MM' },
        { name: 'region', type: 'TEXT', desc: 'North, South, East, or West' },
        { name: 'revenue', type: 'INTEGER', desc: 'Revenue in dollars' },
        { name: 'orders', type: 'INTEGER', desc: 'Number of orders' },
      ],
      rows: [
        ['2024-01', 'North', 33330, 511],
        ['2024-01', 'South', 27080, 427],
        ['2024-01', 'East', 40340, 681],
        ['2024-01', 'West', 35710, 548],
        ['2024-02', 'North', 30330, 487],
        ['2024-02', 'South', 30560, 441],
        ['2024-02', 'East', 38710, 654],
        ['2024-02', 'West', 34200, 568],
        ['2024-03', 'North', 38510, 571],
        ['2024-03', 'South', 30030, 482],
        ['2024-03', 'East', 50480, 764],
        ['2024-03', 'West', 41010, 593],
        ['2024-04', 'North', 42970, 615],
        ['2024-04', 'South', 36670, 550],
        ['2024-04', 'East', 51010, 765],
        ['2024-04', 'West', 45100, 761],
        ['2024-05', 'North', 40440, 690],
        ['2024-05', 'South', 36270, 547],
        ['2024-05', 'East', 54760, 848],
        ['2024-05', 'West', 51840, 874],
        ['2024-06', 'North', 45790, 657],
        ['2024-06', 'South', 35300, 599],
        ['2024-06', 'East', 53010, 890],
        ['2024-06', 'West', 50020, 801],
        ['2024-07', 'North', 40950, 702],
        ['2024-07', 'South', 37700, 568],
        ['2024-07', 'East', 54950, 897],
        ['2024-07', 'West', 50510, 758],
        ['2024-08', 'North', 44870, 734],
        ['2024-08', 'South', 38100, 606],
        ['2024-08', 'East', 53280, 776],
        ['2024-08', 'West', 49580, 849],
        ['2024-09', 'North', 52700, 897],
        ['2024-09', 'South', 43610, 698],
        ['2024-09', 'East', 61340, 1050],
        ['2024-09', 'West', 51920, 756],
        ['2024-10', 'North', 54200, 855],
        ['2024-10', 'South', 39020, 636],
        ['2024-10', 'East', 55250, 949],
        ['2024-10', 'West', 52210, 762],
        ['2024-11', 'North', 55120, 864],
        ['2024-11', 'South', 45440, 666],
        ['2024-11', 'East', 68140, 1120],
        ['2024-11', 'West', 61490, 884],
        ['2024-12', 'North', 71820, 1030],
        ['2024-12', 'South', 59190, 986],
        ['2024-12', 'East', 80100, 1315],
        ['2024-12', 'West', 83440, 1192],
      ],
    },
  };

  // Display groups for the overview page's "Practice data" section and the
  // tutor prompt. Order is the order a learner meets them.
  const DATASET_GROUPS = [
    { id: 'practice', title: 'Practice datasets', tables: ['nfl_team_stats', 'grocery_store_data', 'bank_statement'] },
    { id: 'bookstore', title: 'Page Turner Books', tables: ['authors', 'books', 'customers', 'orders', 'order_items', 'formats', 'subscriptions'] },
    { id: 'company', title: 'Page Turner company', tables: ['departments', 'employees', 'monthly_sales'] },
  ];

  function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  function createTableSql(tableId) {
    const ds = DATASETS[tableId];
    if (!ds) throw new Error(`Unknown dataset: ${tableId}`);
    const cols = ds.columns.map(c => `${quoteIdent(c.name)} ${c.type}${c.pk ? ' PRIMARY KEY' : ''}`);
    return `CREATE TABLE ${quoteIdent(tableId)} (${cols.join(', ')})`;
  }

  // RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF line endings.
  // The shipped CSVs are simple, but this keeps working if one gains a
  // quoted comma later.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function coerce(value, type) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    if (value === '') return null;
    if (type === 'INTEGER') { const n = parseInt(value, 10); return Number.isNaN(n) ? value : n; }
    if (type === 'REAL') { const n = parseFloat(value); return Number.isNaN(n) ? value : n; }
    return value;
  }

  // Turns CSV text into typed rows in the dataset's declared column order
  // (matched by header name, so a reordered CSV still loads correctly).
  function rowsFromCsv(tableId, text) {
    const ds = DATASETS[tableId];
    const [header, ...body] = parseCsv(text);
    const index = ds.columns.map(c => header.indexOf(c.name));
    const missing = ds.columns.filter((c, i) => index[i] === -1).map(c => c.name);
    if (missing.length) throw new Error(`${ds.csv} is missing column(s): ${missing.join(', ')}`);
    return body.map(r => ds.columns.map((c, i) => coerce(r[index[i]], c.type)));
  }

  const csvCache = new Map();

  async function rowsFor(tableId, fetchText) {
    const ds = DATASETS[tableId];
    if (ds.rows) return ds.rows;
    if (!csvCache.has(tableId)) {
      csvCache.set(tableId, Promise.resolve(fetchText(ds.csv)).then(text => rowsFromCsv(tableId, text)));
    }
    try {
      return await csvCache.get(tableId);
    } catch (err) {
      csvCache.delete(tableId); // let a retry refetch instead of caching the failure
      throw err;
    }
  }

  // Creates and fills each table in `tableIds` inside an open sql.js
  // Database. `fetchText(path)` resolves a CSV path to its text: fetch()
  // in the browser, fs.readFile in tests.
  async function loadInto(db, tableIds, { fetchText } = {}) {
    for (const id of tableIds) {
      const ds = DATASETS[id];
      if (!ds) throw new Error(`Unknown dataset: ${id}`);
      if (!ds.rows && typeof fetchText !== 'function') throw new Error(`Loading ${id} needs a fetchText function`);
      const rows = await rowsFor(id, fetchText);
      db.run(createTableSql(id));
      const placeholders = ds.columns.map(() => '?').join(', ');
      const stmt = db.prepare(`INSERT INTO ${quoteIdent(id)} VALUES (${placeholders})`);
      try {
        db.run('BEGIN');
        for (const r of rows) stmt.run(r);
        db.run('COMMIT');
      } finally {
        stmt.free();
      }
    }
  }

  // Plain-text schema used in the AI tutor's system prompt and the
  // editor's schema panel.
  function schemaText(tableIds) {
    return tableIds.map(id => {
      const ds = DATASETS[id];
      const cols = ds.columns.map(c => `  - ${c.name} ${c.type}${c.pk ? ' (primary key)' : ''}${c.fk ? ` (references ${c.fk})` : ''}: ${c.desc}`);
      return `Table ${id}: ${ds.description}\n${cols.join('\n')}`;
    }).join('\n\n');
  }

  return { DATASETS, DATASET_GROUPS, createTableSql, parseCsv, rowsFromCsv, loadInto, schemaText, quoteIdent };
});
