const fp = require('lodash/fp');
const _ = require('lodash');
const sql = require('./sql');

const { DatabaseAnalyser } = require('dbgate-tools');
const { isTypeString, isTypeNumeric } = require('dbgate-tools');

function getColumnInfo({
  isNullable,
  extra,
  columnName,
  dataType,
  charMaxLength,
  numericPrecision,
  numericScale,
  defaultValue,
  columnComment,
  columnType,
}) {
  const columnTypeTokens = _.isString(columnType) ? columnType.split(' ').map(x => x.trim().toLowerCase()) : [];
  let fullDataType = dataType;
  if (charMaxLength && isTypeString(dataType)) fullDataType = `${dataType}(${charMaxLength})`;
  if (numericPrecision && numericScale && isTypeNumeric(dataType))
    fullDataType = `${dataType}(${numericPrecision},${numericScale})`;
  return {
    notNull: !isNullable || isNullable == 'NO' || isNullable == 'no',
    autoIncrement: !!(extra && extra.toLowerCase().includes('auto_increment')),
    columnName,
    columnComment,
    dataType: fullDataType,
    defaultValue,
    isUnsigned: columnTypeTokens.includes('unsigned'),
    isZerofill: columnTypeTokens.includes('zerofill'),
  };
}

class Analyser extends DatabaseAnalyser {
  constructor(pool, driver, version) {
    super(pool, driver, version);
  }

  createQuery(resFileName, typeFields) {
    let res = sql[resFileName];
    res = res.replace('#DATABASE#', this.pool._database_name);
    return super.createQuery(res, typeFields);
  }

  getRequestedViewNames(allViewNames) {
    return this.getRequestedObjectPureNames('views', allViewNames);
  }

  async _computeSingleObjectId() {
    const { pureName } = this.singleObjectFilter;
    this.singleObjectId = pureName;
  }

  async getViewTexts(allViewNames) {
    const res = {};

    const views = await this.safeQuery(this.createQuery('viewTexts', ['views']));
    for (const view of views.rows) {
      res[view.pureName] = `CREATE VIEW \`${view.pureName}\` AS ${view.viewDefinition}`;
    }

    // for (const viewName of this.getRequestedViewNames(allViewNames)) {
    //   try {
    //     const resp = await this.driver.query(this.pool, `SHOW CREATE VIEW \`${viewName}\``);
    //     res[viewName] = resp.rows[0]['Create View'];
    //   } catch (err) {
    //     console.log('ERROR', err);
    //     res[viewName] = `${err}`;
    //   }
    // }
    return res;
  }

  async _runAnalysis() {
    this.feedback({ analysingMessage: 'Loading tables' });
    const tables = await this.driver.query(this.pool, this.createQuery('tables', ['tables']));
    this.feedback({ analysingMessage: 'Loading columns' });
    const columns = await this.driver.query(this.pool, this.createQuery('columns', ['tables', 'views']));
    this.feedback({ analysingMessage: 'Loading primary keys' });
    const pkColumns = await this.safeQuery(this.createQuery('primaryKeys', ['tables']));
    this.feedback({ analysingMessage: 'Loading foreign keys' });
    const fkColumns = await this.safeQuery(this.createQuery('foreignKeys', ['tables']));
    this.feedback({ analysingMessage: 'Loading views' });
    const views = await this.safeQuery(this.createQuery('views', ['views']));
    this.feedback({ analysingMessage: 'Loading programmables' });
    const programmables = await this.safeQuery(this.createQuery('programmables', ['procedures', 'functions']));

    this.feedback({ analysingMessage: 'Loading view texts' });
    const viewTexts = await this.getViewTexts(views.rows.map(x => x.pureName));
    this.feedback({ analysingMessage: 'Loading indexes' });
    const indexes = await this.safeQuery(this.createQuery('indexes', ['tables']));
    this.feedback({ analysingMessage: 'Loading uniques' });
    const uniqueNames = await this.safeQuery(this.createQuery('uniqueNames', ['tables']));
    this.feedback({ analysingMessage: 'Finalizing DB structure' });

    const res = {
      tables: tables.rows.map(table => ({
        ...table,
        objectId: table.pureName,
        contentHash: _.isDate(table.modifyDate) ? table.modifyDate.toISOString() : table.modifyDate,
        columns: columns.rows.filter(col => col.pureName == table.pureName).map(getColumnInfo),
        primaryKey: DatabaseAnalyser.extractPrimaryKeys(table, pkColumns.rows),
        foreignKeys: DatabaseAnalyser.extractForeignKeys(table, fkColumns.rows),
        tableRowCount: table.tableRowCount,
        indexes: _.uniqBy(
          indexes.rows.filter(
            idx =>
              idx.tableName == table.pureName && !uniqueNames.rows.find(x => x.constraintName == idx.constraintName)
          ),
          'constraintName'
        ).map(idx => ({
          ..._.pick(idx, ['constraintName', 'indexType']),
          isUnique: !idx.nonUnique,
          columns: indexes.rows
            .filter(col => col.tableName == idx.tableName && col.constraintName == idx.constraintName)
            .map(col => ({
              ..._.pick(col, ['columnName']),
            })),
        })),

        uniques: _.uniqBy(
          indexes.rows.filter(
            idx => idx.tableName == table.pureName && uniqueNames.rows.find(x => x.constraintName == idx.constraintName)
          ),
          'constraintName'
        ).map(idx => ({
          ..._.pick(idx, ['constraintName']),
          columns: indexes.rows
            .filter(col => col.tableName == idx.tableName && col.constraintName == idx.constraintName)
            .map(col => ({
              ..._.pick(col, ['columnName']),
            })),
        })),
      })),
      views: views.rows.map(view => ({
        ...view,
        objectId: view.pureName,
        contentHash: _.isDate(view.modifyDate) ? view.modifyDate.toISOString() : view.modifyDate,
        columns: columns.rows.filter(col => col.pureName == view.pureName).map(getColumnInfo),
        createSql: viewTexts[view.pureName],
        requiresFormat: true,
      })),
      procedures: programmables.rows
        .filter(x => x.objectType == 'PROCEDURE')
        .map(fp.omit(['objectType']))
        .map(x => ({
          ...x,
          createSql: `DELIMITER //\n\nCREATE PROCEDURE \`${x.pureName}\`()\n${x.routineDefinition}\n\nDELIMITER ;\n`,
          objectId: x.pureName,
          contentHash: _.isDate(x.modifyDate) ? x.modifyDate.toISOString() : x.modifyDate,
        })),
      functions: programmables.rows
        .filter(x => x.objectType == 'FUNCTION')
        .map(fp.omit(['objectType']))
        .map(x => ({
          ...x,
          createSql: `CREATE FUNCTION \`${x.pureName}\`()\nRETURNS ${x.returnDataType} ${
            x.isDeterministic == 'YES' ? 'DETERMINISTIC' : 'NOT DETERMINISTIC'
          }\n${x.routineDefinition}`,
          objectId: x.pureName,
          contentHash: _.isDate(x.modifyDate) ? x.modifyDate.toISOString() : x.modifyDate,
        })),
    };
    this.feedback({ analysingMessage: null });
    return res;
  }

  async _getFastSnapshot() {
    const tableModificationsQueryData = await this.driver.query(this.pool, this.createQuery('tableModifications'));
    const procedureModificationsQueryData = await this.driver.query(
      this.pool,
      this.createQuery('procedureModifications')
    );
    const functionModificationsQueryData = await this.driver.query(
      this.pool,
      this.createQuery('functionModifications')
    );

    return {
      tables: tableModificationsQueryData.rows
        .filter(x => x.objectType == 'BASE TABLE')
        .map(x => ({
          ...x,
          objectId: x.pureName,
          contentHash: _.isDate(x.modifyDate) ? x.modifyDate.toISOString() : x.modifyDate,
          tableRowCount: x.tableRowCount,
        })),
      views: tableModificationsQueryData.rows
        .filter(x => x.objectType == 'VIEW')
        .map(x => ({
          ...x,
          objectId: x.pureName,
          contentHash: _.isDate(x.modifyDate) ? x.modifyDate.toISOString() : x.modifyDate,
        })),
      procedures: procedureModificationsQueryData.rows.map(x => ({
        contentHash: x.Modified,
        objectId: x.Name,
        pureName: x.Name,
      })),
      functions: functionModificationsQueryData.rows.map(x => ({
        contentHash: x.Modified,
        objectId: x.Name,
        pureName: x.Name,
      })),
    };
  }
}

module.exports = Analyser;
