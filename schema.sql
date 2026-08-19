-- ==========================================================
-- Database: promotersdatadb
-- Setup Script: Hierarchy Locations & Promoters Table
-- ==========================================================

USE `promotersdatadb`;

-- 1. Hierarchy Locations Table
DROP TABLE IF EXISTS `hierarchy_locations`;

CREATE TABLE `hierarchy_locations` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `district` VARCHAR(100) NOT NULL,
    `zone` VARCHAR(100) NOT NULL,
    `circle` VARCHAR(100) NOT NULL
);

-- 2. Promoters Table
CREATE TABLE IF NOT EXISTS `promoters` (
    `id` VARCHAR(50) NOT NULL PRIMARY KEY,
    `fullName` VARCHAR(255) NOT NULL,
    `mobileNumber` VARCHAR(15) NOT NULL,
    `level` ENUM('District', 'Zone', 'Circle') NOT NULL,
    `district` VARCHAR(100) NOT NULL,
    `zone` VARCHAR(100) DEFAULT NULL,
    `circle` VARCHAR(100) DEFAULT NULL,
    `timestamp` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `unique_mobile` (`mobileNumber`)
);
