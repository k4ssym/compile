// models/function.js
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
    },
    createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
    },
    updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
    }
}, {
    timestamps: true,  // Автоматически управляет полями createdAt и updatedAt
    tableName: 'functions'
});

User.hasMany(Function, { foreignKey: 'userId' });
Function.belongsTo(User, { foreignKey: 'userId' });

export default Function;
