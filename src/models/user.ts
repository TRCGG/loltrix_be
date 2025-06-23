import Sequelize from 'sequelize';

class User extends Sequelize.Model {
  static initiate(sequelize: any) {}

  static associate(db: any) {}
}

export default User;
