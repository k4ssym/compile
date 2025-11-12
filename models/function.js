import { DataTypes } from 'sequelize';
import sequelize from './index.js';
import User from './user.js';

const Function = sequelize.define('Function', {
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  code: { 
    type: DataTypes.TEXT,
    allowNull: false,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: User,
      key: 'id'
    }
  }
}, {
  tableName: 'functions'
});

User.hasMany(Function, { foreignKey: 'userId' });
Function.belongsTo(User, { foreignKey: 'userId' });

export default Function;