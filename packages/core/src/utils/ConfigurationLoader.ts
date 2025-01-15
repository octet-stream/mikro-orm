import dotenv from 'dotenv';
import { pathExistsSync, readJSONSync, realpathSync } from 'fs-extra';
import { platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EntityManager } from '../EntityManager';
import type { EntityManagerType, IDatabaseDriver } from '../drivers';
import { colors } from '../logging/colors';
import type { Dictionary } from '../typings';
import { Configuration, type Options } from './Configuration';
import { Utils } from './Utils';
import { type LoaderOption, createLoader } from './loader';

const falsyStrings = ['false', 'f', '0', 'no', 'n', ''];

const truthyStrings = ['true', 't', '1', 'yes', 'y'];

const toBoolean = (value: string) => truthyStrings.includes(value);

/**
 * Returns valid value for `loader` option from given environment `MIKRO_ORM_CLI_LOADER` variable.
 *
 * @param value - A raw value of the environment variable
 *
 * @internal
 */
function loaderOptionFromEnv(value: string): LoaderOption {
  const maybeBoolean = value.toLowerCase();
  if (falsyStrings.includes(maybeBoolean)) {
    return false;
  }

  // Return `auto` if the `value` can be converted to `true`, so behaviour will be the same as in createLoader
  if (truthyStrings.includes(maybeBoolean)) {
    return 'auto';
  }

  return value as LoaderOption;
}

/**
 * @internal
 */
export class ConfigurationLoader {

  /**
   * Gets a named configuration
   *
   * @param contextName Load a config with the given `contextName` value. Used when config file exports array or factory function. Setting it to "default" matches also config objects without `contextName` set.
   * @param paths Array of possible paths for a configuration file. Files will be checked in order, and the first existing one will be used. Defaults to the output of {@link ConfigurationLoader.getConfigPaths}.
   * @param options Additional options to augment the final configuration with.
   */
  static async getConfiguration<D extends IDatabaseDriver = IDatabaseDriver, EM extends D[typeof EntityManagerType] & EntityManager = EntityManager>(contextName: string, paths?: string[], options?: Partial<Options>): Promise<Configuration<D, EM>>;
  /**
   * Gets the default config from the default paths
   *
   * @deprecated Prefer to explicitly set the `contextName` at the first argument. This signature is available for backwards compatibility, and may be removed in v7.
   */
  static async getConfiguration<D extends IDatabaseDriver = IDatabaseDriver, EM extends D[typeof EntityManagerType] & EntityManager = EntityManager>(): Promise<Configuration<D, EM>>;
  /**
   * Gets default configuration out of the default paths, and possibly from `process.argv`
   *
   * @param validate Whether to validate the final configuration.
   * @param options Additional options to augment the final configuration with (just before validation).
   *
   * @deprecated Use the other overloads of this method. This signature will be removed in v7.
   */
  static async getConfiguration<D extends IDatabaseDriver = IDatabaseDriver, EM extends D[typeof EntityManagerType] & EntityManager = EntityManager>(validate: boolean, options?: Partial<Options>): Promise<Configuration<D, EM>>;
  static async getConfiguration<D extends IDatabaseDriver = IDatabaseDriver, EM extends D[typeof EntityManagerType] & EntityManager = EntityManager>(contextName: boolean | string = 'default', paths: string[] | Partial<Options> = ConfigurationLoader.getConfigPaths(), options: Partial<Options> = {}): Promise<Configuration<D, EM>> {
    const settings = ConfigurationLoader.getSettings();
    const basePath = options.baseDir ?? process.cwd();

    // Backwards compatibility layer
    if (typeof contextName === 'boolean' || !Array.isArray(paths)) {
      this.commonJSCompat(options);
      this.registerDotenv(options);
      const configPathFromArg = ConfigurationLoader.configPathsFromArg();
      const configPaths = configPathFromArg ?? (Array.isArray(paths) ? paths : ConfigurationLoader.getConfigPaths());
      const config = contextName
        ? (await ConfigurationLoader.getConfiguration<D, EM>(process.env.MIKRO_ORM_CONTEXT_NAME ?? 'default', configPaths, Array.isArray(paths) ? {} : paths))
        : await (async () => {
          const env = this.loadEnvironmentVars();
          const [path, tmp] = await this.getConfigFile(configPaths, basePath, settings);
          if (!path) {
            if (Utils.hasObjectKeys(env)) {
              return new Configuration(Utils.mergeConfig({}, options, env), false);
            }
            throw new Error(`MikroORM config file not found in ['${configPaths.join(`', '`)}']`);
          }
          return new Configuration(Utils.mergeConfig(tmp, options, env), false);
        })() as Configuration<D, EM>;
      if (configPathFromArg) {
        config.getLogger().warn('deprecated', 'Path for config file was inferred from the command line arguments. Instead, you should set the MIKRO_ORM_CLI_CONFIG environment variable to specify the path, or if you really must use the command line arguments, import the config manually based on them, and pass it to init.', { label: 'D0001' });
      }
      return config;
    }

    const env = this.loadEnvironmentVars();

    const configFinder = (cfg: unknown) => {
      return typeof cfg === 'object' && cfg !== null && ('contextName' in cfg ? cfg.contextName === contextName : (contextName === 'default'));
    };

    const isValidConfigFactoryResult = (cfg: unknown) => {
      return typeof cfg === 'object' && cfg !== null && (!('contextName' in cfg) || cfg.contextName === contextName);
    };

    const result = await this.getConfigFile(paths, basePath, settings);
    if (!result[0]) {
      if (Utils.hasObjectKeys(env)) {
        return new Configuration(Utils.mergeConfig({ contextName }, options, env));
      }
      throw new Error(`MikroORM config file not found in ['${paths.join(`', '`)}']`);
    }

    const path = result[0];
    let tmp = result[1];

    if (Array.isArray(tmp)) {
      const tmpFirstIndex = tmp.findIndex(configFinder);
      if (tmpFirstIndex === -1) {
        // Static config not found. Try factory functions
        let configCandidate: unknown;
        for (let i = 0, l = tmp.length; i < l; ++i) {
          const f = tmp[i];
          if (typeof f !== 'function') {
            continue;
          }
          configCandidate = await f(contextName);
          if (!isValidConfigFactoryResult(configCandidate)) {
            continue;
          }
          tmp = configCandidate;
          break;
        }
        if (Array.isArray(tmp)) {
          throw new Error(`MikroORM config '${contextName}' was not found within the config file '${path}'. Either add a config with this name to the array, or add a function that when given this name will return a configuration object without a name, or with name set to this name.`);
        }
      } else {
        const tmpLastIndex = tmp.findLastIndex(configFinder);
        if (tmpLastIndex !== tmpFirstIndex) {
          throw new Error(`MikroORM config '${contextName}' is not unique within the array exported by '${path}' (first occurrence index: ${tmpFirstIndex}; last occurrence index: ${tmpLastIndex})`);
        }
        tmp = tmp[tmpFirstIndex];
      }
    } else {
      if (tmp instanceof Function) {
        tmp = await tmp(contextName);

        if (!isValidConfigFactoryResult(tmp)) {
          throw new Error(`MikroORM config '${contextName}' was not what the function exported from '${path}' provided. Ensure it returns a config object with no name, or name matching the requested one.`);
        }
      } else {
        if (!configFinder(tmp)) {
          throw new Error(`MikroORM config '${contextName}' was not what the default export from '${path}' provided.`);
        }
      }
    }

    const esmConfigOptions = this.isESM() ? { entityGenerator: { esmImport: true } } : {};

    return new Configuration(Utils.mergeConfig({}, esmConfigOptions, tmp, options, env));
  }

  static async getConfigFile(paths: string[], basePath: string, settings: Settings): Promise<[string, unknown] | []> {
    const configLoader = await createLoader(basePath, settings);
    for (let path of paths) {
      path = Utils.absolutePath(path);
      path = Utils.normalizePath(path);

      if (pathExistsSync(path)) {
        const config = await configLoader.import(path);

        return [path, config];
      }
    }
    return [];
  }

  static getPackageConfig(basePath = process.cwd()): Dictionary {
    if (pathExistsSync(`${basePath}/package.json`)) {
      /* istanbul ignore next */
      try {
        return readJSONSync(`${basePath}/package.json`);
      } catch {
        return {};
      }
    }

    const parentFolder = realpathSync(`${basePath}/..`);

    // we reached the root folder
    if (basePath === parentFolder) {
      return {};
    }

    return this.getPackageConfig(parentFolder);
  }

  static getSettings(): Settings {
    const config = ConfigurationLoader.getPackageConfig();
    const settings: Settings = { ...config['mikro-orm'] };

    settings.tsConfigPath = process.env.MIKRO_ORM_CLI_TS_CONFIG_PATH ?? settings.tsConfigPath;
    settings.verbose = process.env.MIKRO_ORM_CLI_VERBOSE != null ? toBoolean(process.env.MIKRO_ORM_CLI_VERBOSE) : settings.verbose;

    settings.useTsNode = process.env.MIKRO_ORM_CLI_USE_TS_NODE != null ? toBoolean(process.env.MIKRO_ORM_CLI_USE_TS_NODE) : settings.useTsNode;
    settings.alwaysAllowTs = process.env.MIKRO_ORM_CLI_ALWAYS_ALLOW_TS != null ? toBoolean(process.env.MIKRO_ORM_CLI_ALWAYS_ALLOW_TS) : settings.alwaysAllowTs;
    settings.loader = process.env.MIKRO_ORM_CLI_LOADER != null ? loaderOptionFromEnv(process.env.MIKRO_ORM_CLI_LOADER) : settings.loader;

    if (process.env.MIKRO_ORM_CLI_CONFIG?.endsWith('.ts')) {
      settings.useTsNode = true;
    }

    return settings;
  }

  static configPathsFromArg() {
    const options = Utils.parseArgs();
    const configArgName = process.env.MIKRO_ORM_CONFIG_ARG_NAME ?? 'config';

    if (options[configArgName]) {
      return [options[configArgName]] as string[];
    }
    return undefined;
  }

  static getConfigPaths(): string[] {
    const paths: string[] = [];
    const settings = ConfigurationLoader.getSettings();

    if (process.env.MIKRO_ORM_CLI_CONFIG) {
      paths.push(process.env.MIKRO_ORM_CLI_CONFIG);
    }

    paths.push(...(settings.configPaths || []));
    const alwaysAllowTs = settings.alwaysAllowTs ?? process.versions.bun;

    if (settings.useTsNode !== false || alwaysAllowTs) {
      paths.push('./src/mikro-orm.config.ts');
      paths.push('./mikro-orm.config.ts');
    }

    const distDir = pathExistsSync(process.cwd() + '/dist');
    const buildDir = pathExistsSync(process.cwd() + '/build');
    /* istanbul ignore next */
    const path = distDir ? 'dist' : (buildDir ? 'build' : 'src');
    paths.push(`./${path}/mikro-orm.config.js`);
    paths.push('./mikro-orm.config.js');
    const tsNode = Utils.detectTsNode();

    return Utils.unique(paths).filter(p => p.endsWith('.js') || tsNode || alwaysAllowTs);
  }

  static isESM(): boolean {
    const config = ConfigurationLoader.getPackageConfig();
    const type = config?.type ?? '';

    return type === 'module';
  }

  static registerTsNode(configPath = 'tsconfig.json'): boolean {
    /* istanbul ignore next */
    if (process.versions.bun) {
      return true;
    }

    const tsConfigPath = isAbsolute(configPath) ? configPath : join(process.cwd(), configPath);

    const tsNode = Utils.tryRequire({
      module: 'ts-node',
      from: tsConfigPath,
      warning: 'ts-node not installed, support for working with TS files might not work',
    });

    /* istanbul ignore next */
    if (!tsNode) {
      return false;
    }

    const { options } = tsNode.register({
      project: tsConfigPath,
      transpileOnly: true,
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
      },
    }).config;

    if (Object.entries(options?.paths ?? {}).length > 0) {
      Utils.requireFrom('tsconfig-paths', tsConfigPath).register({
        baseUrl: options.baseUrl ?? '.',
        paths: options.paths,
      });
    }

    return true;
  }

  static registerDotenv<D extends IDatabaseDriver>(options?: Options<D> | Configuration<D>): void {
    const baseDir = options instanceof Configuration ? options.get('baseDir') : options?.baseDir;
    const path = process.env.MIKRO_ORM_ENV ?? ((baseDir ?? process.cwd()) + '/.env');
    const env = {} as Dictionary;
    dotenv.config({ path, processEnv: env });

    // only propagate known env vars
    for (const key of Object.keys(env)) {
      if (key.startsWith('MIKRO_ORM_')) {
        process.env[key] ??= env[key]; // respect user provided values
      }
    }
  }

  static loadEnvironmentVars<D extends IDatabaseDriver>(): Partial<Options<D>> {
    const ret: Dictionary = {};

    // only to keep some sort of back compatibility with those using env vars only, to support `MIKRO_ORM_TYPE`
    const PLATFORMS = {
      'mongo': { className: 'MongoDriver', module: '@mikro-orm/mongodb' },
      'mysql': { className: 'MySqlDriver', module: '@mikro-orm/mysql' },
      'mssql': { className: 'MsSqlDriver', module: '@mikro-orm/mssql' },
      'mariadb': { className: 'MariaDbDriver', module: '@mikro-orm/mariadb' },
      'postgresql': { className: 'PostgreSqlDriver', module: '@mikro-orm/postgresql' },
      'sqlite': { className: 'SqliteDriver', module: '@mikro-orm/sqlite' },
      'better-sqlite': { className: 'BetterSqliteDriver', module: '@mikro-orm/better-sqlite' },
      'libsql': { className: 'LibSqlDriver', module: '@mikro-orm/libsql' },
    } as Dictionary;

    const array = (v: string) => v.split(',').map(vv => vv.trim());
    const num = (v: string) => +v;
    const driver = (v: string) => Utils.requireFrom(PLATFORMS[v].module)[PLATFORMS[v].className];
    const read = (o: Dictionary, envKey: string, key: string, mapper: (v: string) => unknown = v => v) => {
      if (!(envKey in process.env)) {
        return;
      }

      const val = process.env[envKey]!;
      o[key] = mapper(val);
    };
    const cleanup = (o: Dictionary, k: string) => Utils.hasObjectKeys(o[k]) ? {} : delete o[k];

    read(ret, 'MIKRO_ORM_BASE_DIR', 'baseDir');
    read(ret, 'MIKRO_ORM_TYPE', 'driver', driver);
    read(ret, 'MIKRO_ORM_ENTITIES', 'entities', array);
    read(ret, 'MIKRO_ORM_ENTITIES_TS', 'entitiesTs', array);
    read(ret, 'MIKRO_ORM_CLIENT_URL', 'clientUrl');
    read(ret, 'MIKRO_ORM_HOST', 'host');
    read(ret, 'MIKRO_ORM_PORT', 'port', num);
    read(ret, 'MIKRO_ORM_USER', 'user');
    read(ret, 'MIKRO_ORM_PASSWORD', 'password');
    read(ret, 'MIKRO_ORM_DB_NAME', 'dbName');
    read(ret, 'MIKRO_ORM_SCHEMA', 'schema');
    read(ret, 'MIKRO_ORM_LOAD_STRATEGY', 'loadStrategy');
    read(ret, 'MIKRO_ORM_BATCH_SIZE', 'batchSize', num);
    read(ret, 'MIKRO_ORM_USE_BATCH_INSERTS', 'useBatchInserts', toBoolean);
    read(ret, 'MIKRO_ORM_USE_BATCH_UPDATES', 'useBatchUpdates', toBoolean);
    read(ret, 'MIKRO_ORM_STRICT', 'strict', toBoolean);
    read(ret, 'MIKRO_ORM_VALIDATE', 'validate', toBoolean);
    read(ret, 'MIKRO_ORM_ALLOW_GLOBAL_CONTEXT', 'allowGlobalContext', toBoolean);
    read(ret, 'MIKRO_ORM_AUTO_JOIN_ONE_TO_ONE_OWNER', 'autoJoinOneToOneOwner', toBoolean);
    read(ret, 'MIKRO_ORM_POPULATE_AFTER_FLUSH', 'populateAfterFlush', toBoolean);
    read(ret, 'MIKRO_ORM_FORCE_ENTITY_CONSTRUCTOR', 'forceEntityConstructor', toBoolean);
    read(ret, 'MIKRO_ORM_FORCE_UNDEFINED', 'forceUndefined', toBoolean);
    read(ret, 'MIKRO_ORM_FORCE_UTC_TIMEZONE', 'forceUtcTimezone', toBoolean);
    read(ret, 'MIKRO_ORM_TIMEZONE', 'timezone');
    read(ret, 'MIKRO_ORM_ENSURE_INDEXES', 'ensureIndexes', toBoolean);
    read(ret, 'MIKRO_ORM_IMPLICIT_TRANSACTIONS', 'implicitTransactions', toBoolean);
    read(ret, 'MIKRO_ORM_DEBUG', 'debug', toBoolean);
    read(ret, 'MIKRO_ORM_COLORS', 'colors', toBoolean);

    ret.discovery = {};
    read(ret.discovery, 'MIKRO_ORM_DISCOVERY_WARN_WHEN_NO_ENTITIES', 'warnWhenNoEntities', toBoolean);
    read(ret.discovery, 'MIKRO_ORM_DISCOVERY_REQUIRE_ENTITIES_ARRAY', 'requireEntitiesArray', toBoolean);
    read(ret.discovery, 'MIKRO_ORM_DISCOVERY_ALWAYS_ANALYSE_PROPERTIES', 'alwaysAnalyseProperties', toBoolean);
    read(ret.discovery, 'MIKRO_ORM_DISCOVERY_DISABLE_DYNAMIC_FILE_ACCESS', 'disableDynamicFileAccess', toBoolean);
    cleanup(ret, 'discovery');

    ret.migrations = {};
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_TABLE_NAME', 'tableName');
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_PATH', 'path');
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_PATH_TS', 'pathTs');
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_GLOB', 'glob');
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_TRANSACTIONAL', 'transactional', toBoolean);
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_DISABLE_FOREIGN_KEYS', 'disableForeignKeys', toBoolean);
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_ALL_OR_NOTHING', 'allOrNothing', toBoolean);
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_DROP_TABLES', 'dropTables', toBoolean);
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_SAFE', 'safe', toBoolean);
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_SILENT', 'silent', toBoolean);
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_EMIT', 'emit');
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_SNAPSHOT', 'snapshot', toBoolean);
    read(ret.migrations, 'MIKRO_ORM_MIGRATIONS_SNAPSHOT_NAME', 'snapshotName');
    cleanup(ret, 'migrations');

    ret.schemaGenerator = {};
    read(ret.schemaGenerator, 'MIKRO_ORM_SCHEMA_GENERATOR_DISABLE_FOREIGN_KEYS', 'disableForeignKeys', toBoolean);
    read(ret.schemaGenerator, 'MIKRO_ORM_SCHEMA_GENERATOR_CREATE_FOREIGN_KEY_CONSTRAINTS', 'createForeignKeyConstraints', toBoolean);
    cleanup(ret, 'schemaGenerator');

    ret.seeder = {};
    read(ret.seeder, 'MIKRO_ORM_SEEDER_PATH', 'path');
    read(ret.seeder, 'MIKRO_ORM_SEEDER_PATH_TS', 'pathTs');
    read(ret.seeder, 'MIKRO_ORM_SEEDER_GLOB', 'glob');
    read(ret.seeder, 'MIKRO_ORM_SEEDER_EMIT', 'emit');
    read(ret.seeder, 'MIKRO_ORM_SEEDER_DEFAULT_SEEDER', 'defaultSeeder');
    cleanup(ret, 'seeder');

    return ret;
  }

  static getORMPackages(): Set<string> {
    const pkg = this.getPackageConfig();
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  }

  /** @internal */
  static commonJSCompat(options: Partial<Options>): void {
    if (this.isESM()) {
      return;
    }

    /* istanbul ignore next */
    options.dynamicImportProvider ??= id => {
      if (platform() === 'win32') {
        try {
          id = fileURLToPath(id);
        } catch {
          // ignore
        }
      }

      return Utils.requireFrom(id);
    };

    Utils.setDynamicImportProvider(options.dynamicImportProvider);
  }

  static getORMPackageVersion(name: string): string | undefined {
    /* istanbul ignore next */
    try {
      const pkg = Utils.requireFrom(`${name}/package.json`);
      return pkg?.version;
    } catch (e) {
      return undefined;
    }
  }

  // inspired by https://github.com/facebook/docusaurus/pull/3386
  static checkPackageVersion(): string {
    const coreVersion = Utils.getORMVersion();

    if (process.env.MIKRO_ORM_ALLOW_VERSION_MISMATCH) {
      return coreVersion;
    }

    const deps = this.getORMPackages();
    const exceptions = new Set(['nestjs', 'sql-highlighter', 'mongo-highlighter']);
    const ormPackages = [...deps].filter(d => d.startsWith('@mikro-orm/') && d !== '@mikro-orm/core' && !exceptions.has(d.substring('@mikro-orm/'.length)));

    for (const ormPackage of ormPackages) {
      const version = this.getORMPackageVersion(ormPackage);

      if (version != null && version !== coreVersion) {
        throw new Error(
          `Bad ${colors.cyan(ormPackage)} version ${colors.yellow('' + version)}.\n` +
          `All official @mikro-orm/* packages need to have the exact same version as @mikro-orm/core (${colors.green(coreVersion)}).\n` +
          `Only exceptions are packages that don't live in the 'mikro-orm' repository: ${[...exceptions].join(', ')}.\n` +
          `Maybe you want to check, or regenerate your yarn.lock or package-lock.json file?`,
        );
      }
    }

    return coreVersion;
  }

}

/**
 * Command line settings
 */
export interface Settings {
  /**
   * Enable verbose logging (e.g. print queries used in seeder or schema diffing)
   */
  verbose?: boolean;

  /**
   * A custom path to your `tsconfig.json` file
   */
  tsConfigPath?: string;

  /**
   * Custom paths for Mikro ORM config lookup
   */
  configPaths?: string[];

  /**
   * A loader to import Mikro ORM config with.
   * This option enables TypeScript support if the runtime of your choice can't do that for you.
   *
   * You can use `MIKRO_ORM_CLI_LOADER` to set this option via environment variables.
   *
   * The value can be either of these: [`'ts-node'`](https://www.npmjs.com/package/ts-node), [`'jiti'`](https://www.npmjs.com/package/jiti), [`'tsx'`](https://www.npmjs.com/package/tsx), `'auto'`, `'native'`, `false`, `null`, or `undefined`.
   *
   * When set to `'native'`, Mikro ORM will try and use runtime's native [`import()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import) to load config, whether or not the runtime can handle TypeScript files.
   *
   * When set to `'auto'`, Mikro ORM will try and use loaders in following order:
   *
   * 1. `ts-node`
   * 2. `jiti`
   * 3. `tsx`
   * 4. `import()`
   *
   * If none of these can read the config, you will be asked to install either of the packages.
   *
   * The use of `ts-node` as config loader is discouraged and it might be removed in a future releases.
   *
   * @default 'auto'
   */
  loader?: LoaderOption;

  /**
   * Whether or not to bypass TypeScript `loader` and let the runtime to hanlde it
   *
   * @default false
   *
   * @deprecated use `loader` option instead
   */
  alwaysAllowTs?: boolean;

  /**
   * Whether or not use `ts-node` package to import the config.
   *
   * **The package must be installed!**
   *
   * @deprecated use `loader` option instead
   */
  useTsNode?: boolean;

  /**
   * An alias for `useTsNode`
   *
   * @deprecated use `loader` option instead
   */
  preferTs?: boolean;
}
