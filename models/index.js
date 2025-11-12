import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
dotenv.config();

let sequelize;

if (process.env.NODE_ENV === 'production' && process.env.DATABASE_URL) {
  console.log('🔗 Using PostgreSQL database');
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    },
    logging: console.log
  });
} else {
  console.log('💾 Using SQLite database for development');
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './dev.sqlite',
    logging: false
  });
}

export default sequelize;