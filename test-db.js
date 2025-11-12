import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
dotenv.config();

const testConnection = async () => {
    try {
        const sequelize = new Sequelize(process.env.DATABASE_URL, {
            dialect: 'postgres',
            dialectOptions: {
                ssl: {
                    require: true,
                    rejectUnauthorized: false
                }
            }
        });

        await sequelize.authenticate();
        console.log('✅ Database connection successful!');
        
        // Test if we can create tables
        const User = sequelize.define('User', {
            name: { type: Sequelize.STRING },
            email: { type: Sequelize.STRING },
            password: { type: Sequelize.STRING },
            icoins: { type: Sequelize.INTEGER, defaultValue: 200 }
        });

        await User.sync({ force: false });
        console.log('✅ User table synchronized!');
        
        await sequelize.close();
        console.log('✅ Test completed successfully!');
        
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        console.log('💡 Possible solutions:');
        console.log('1. Check if your Render database is running');
        console.log('2. Verify the DATABASE_URL in .env file');
        console.log('3. Check if your IP is allowed in Render database settings');
        console.log('4. Try using a different network/VPN');
    }
};

testConnection();