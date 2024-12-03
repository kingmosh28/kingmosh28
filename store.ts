import {
    configure,
    makeObservable,
    observable,
    computed,
    action,
    runInAction,
    reaction,
} from 'mobx';
import { v4 } from 'uuid';
import Centrifuge from 'centrifuge';
import LS from 'src/common/helpers/localStorageHelper';
import core from 'src/app/api/core';
import getCoefficient from 'src/app/helpers/getCoefficient';
// import isMobile from 'src/common/helpers/isMobile';
import toShortNumber from 'src/app/helpers/toShortNumber';
import shortNumber from 'src/common/helpers/shortNumber';
import range from 'src/app/helpers/range';
import timeout from 'src/app/helpers/timeout';
import floor from 'src/common/helpers/floor';
import randomIntFromInterval from '../helpers/randomIntFromInterval';
import getMaxStep from '../helpers/minesGetMaxStep';

import {
    placeBetRequest,
    placeMultiTapRequest,
    cashoutRequest,
    retriveGameRequest,
    createGameRequest,
} from 'src/app/api';

import { getLimit } from 'src/common/api';

import config from '../config';

import { minesAmountMin } from '../constants';

import { RootStoreProps } from './types';

import {
    TapResponse,
    CashoutResponse,
    GameResponse,
    DeskSize,
} from 'src/app/types';
import formatHeaders from 'src/common/helpers/formatHeaders';

configure({
    enforceActions: 'always',
    // computedRequiresReaction: true,
    // reactionRequiresObservable: true,
    // observableRequiresReaction: true,
    // disableErrorBoundaries: true,
});

const getTheme = () => {
    if (process.env.THEME === 'testb') {
        return 'turbomines';
    }

    return process.env.THEME || 'default';
};

const autobetsDefaults = {
    9: [3, 4, 5],
    25: [10, 11, 12, 13, 14],
    49: [21, 22, 23, 24, 25, 26, 27],
    81: [36, 37, 38, 39, 40, 41, 42, 43, 44],
};

class Store {
    centrifuge: Centrifuge;
    root: RootStoreProps;
    gameName: string;
    gameServerId: string;
    resetTimeout: number | null;
    minesAmountMin: number;

    constructor(root: RootStoreProps) {
        makeObservable(this);
        this.root = root;
        this.centrifuge = new Centrifuge(config.centrifuge, {
            debug: process.env.NODE_ENV === 'development',
        });

        this.gameName =
            getTheme() === 'default' ? 'mines' : getTheme() || 'unset';
        this.gameServerId = this.gameName;
        this.resetTimeout = null;

        this.root.profileCommon.auth(this.gameServerId).then(async () => {
            this.retreiveAmount();
            this.retrieveGame();
        });

        reaction(() => this.hit, this.checkPosition);
        reaction(() => this.autoMode, this.resetTiles);
        reaction(
            () => this.minesAmount,
            () => {
                this.autobetTiles.replace(
                    range(this.deskSize).map((v) => null),
                );
                this.setHit(0);
            },
        );

        this.mockGame();

        this.minesAmountMin = 1;
    }

    @observable retrieveGameLoading = false;
    @observable deskSize: DeskSize = 25;

    @observable roundId: string | null = null;
    @observable roundSeed = '';
    @observable clientSeed = v4();
    @observable serverSeed = undefined;

    @observable turboModeEnabled = false;
    @observable turboAlertShow = false;

    @observable tiles = observable<number | null>(
        range(this.deskSize).map((v) => null),
    );
    @observable autobetTiles = observable<number | null>(
        range(this.deskSize).map((v) => null),
    );

    @observable nonce = 1;
    @observable amount = `1.00`;
    @observable minesAmount = `3`;
    @observable result = 'initial';
    @observable gameResult: TapResponse['result'] | null = null;
    @observable payout = 0;
    @observable coefficient = 0;

    @observable hit = 0;

    @observable gameStarted = false;
    @observable betPlaced = false;
    @observable tapLoading = false;
    @observable betLoading = false;
    @observable tapLoadingIndex: number | null = null;

    // @observable isMobile = isMobile();

    @observable opened: number[] = [];

    @observable myBetsUpdater = 0;
    @observable isOpenedTable = false;
    @observable mobileBetslipOpen = false;
    @observable autobetTilesTimeouts: number[] = [];
    // @observable mobileSettingsChanged = false;

    @computed get autoMode() {
        const { autoModeEnabled } = this.root.autobetCommon;
        return autoModeEnabled;
    }

    @computed get minesAmountMax() {
        const { deskSize } = this;
        return deskSize - 1;
    }
    @computed get targetAmountMax() {
        const { deskSize, minesAmountMin } = this;
        return deskSize - minesAmountMin;
    }
    @computed get targetAmountMin() {
        const { deskSize, minesAmountMax } = this;
        return deskSize - minesAmountMax;
    }

    @computed get lockedUi() {
        const { autoBetEnabled } = this.root.autobetCommon;
        return autoBetEnabled || this.gameStarted;
    }

    @computed get lockedButtons() {
        const {
            uiCommon: { amountError },
            profileCommon: {
                profile: { token },
            },
        } = this.root;
        return (
            !this.gameStarted &&
            (!!amountError ||
                !!this.numberOfBetsError ||
                !token ||
                this.retrieveGameLoading)
        );
    }

    @computed get autobetIndexes(): number[] {
        return this.autobetTiles.filter(
            (item): item is number => typeof item === 'number',
        );
    }

    @computed get numberOfBetsError() {
        const min =
            this.gameName === 'turbomines'
                ? this.minesAmountMin
                : minesAmountMin;

        const targetText = this.gameName === 'dogstreet' ? 'cats' : 'mines';

        if (Number(this.minesAmount) < min) {
            return `Please choose from ${min} to ${this.minesAmountMax} ${targetText}`;
        }
        if (Number(this.minesAmount) > this.minesAmountMax) {
            return `Please choose from ${min} to ${this.minesAmountMax} ${targetText}`;
        }
        if (!Number(this.minesAmount)) {
            return `Please choose from ${min} to ${this.minesAmountMax} ${targetText}`;
        }
        return null;
    }

    @computed get diamondsMax() {
        return getMaxStep(
            this.deskSize,
            Number(this.minesAmount),
            this.root.profileCommon.rtp,
        );
    }

    @action addAutobetTileTimeout = (timeout: number) => {
        this.autobetTilesTimeouts.push(timeout);
    };
    @action clearAutobetTileTimeouts = () => {
        this.autobetTilesTimeouts.forEach((timeout) => {
            clearTimeout(timeout);
        });
        this.autobetTilesTimeouts = [];
    };

    @action setAutobetTilesDefaults = (delay = 50) => {
        this.clearAutobetTileTimeouts();
        const dflt = autobetsDefaults[this.deskSize].slice(0, this.diamondsMax);
        let i = 0;
        this.autobetTiles.forEach((tile, index) => {
            if (dflt.includes(index)) {
                if (delay) {
                    const t = window.setTimeout(() => {
                        this.tapAutoBet(index);
                    }, i * delay);
                    this.addAutobetTileTimeout(t);
                } else {
                    this.tapAutoBet(index);
                }
                // const t = window.setTimeout(() => {
                //     this.tapAutoBet(index);
                // }, i * delay);
                // this.addAutobetTileTimeout(t);
                i++;
            }
        });
    };

    @action setMobileBetslipOpen = (isOpen: boolean) => {
        this.mobileBetslipOpen = isOpen;
    };

    @action setTurboModeEnabled = (enabled: boolean) => {
        this.turboModeEnabled = enabled;
        this.autobetTiles.replace(range(this.deskSize).map((v) => null));
        if (!enabled) {
            this.setHit(0);
            this.clearAutobetTileTimeouts();
        } else {
            this.setAutobetTilesDefaults();
        }
    };

    @action setTurboAlertShow = (show: boolean) => {
        this.turboAlertShow = show;
    };

    @action setDeskSize = (deskSize: DeskSize) => {
        const defaultSize: { [key: number]: number } = {
            9: 2,
            25: 3,
            49: 5,
            81: 10,
        };
        this.deskSize = deskSize;
        this.tiles.replace(range(deskSize).map((v) => null));
        this.autobetTiles.replace(range(deskSize).map((v) => null));
        // if (this.turboModeEnabled) {
        //     this.setAutobetTilesDefaults();
        // }
        this.setMinesAmount(defaultSize[deskSize]);
        if (this.hit) {
            this.setHit(0);
        }
    };
    @action mockGame = () => {
        const { location } = window;
        const { search } = location;
        const queryObj = new URLSearchParams(search);

        if (!queryObj.has('serverSeed')) return;

        runInAction(() => {
            //@ts-ignore
            this.serverSeed = queryObj.get('serverSeed') || undefined;
            //@ts-ignore
            this.nonce = Number(queryObj.get('nonce')) || undefined;
            //@ts-ignore
            this.clientSeed = queryObj.get('clientSeed') || undefined;
        });
    };

    @action checkPosition = (hit: number) => {
        if (hit > 3) {
            const item = document.getElementById(`hit-item-${hit + 2}`);
            if (item) {
                item.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        } else {
            const item = document.getElementById(`hit-item-1`);
            if (item) {
                item.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }
    };

    @action cancelGame = () => {
        this.roundId = null;
        this.resetGame();
    };

    @action startGame = async () => {
        if (this.resetTimeout) {
            clearTimeout(this.resetTimeout);
            this.resetGame();
            this.setGame();
        }
        const {
            profileCommon: {
                profile: { balance },
            },
            uiCommon: { setAlert },
        } = this.root;
        if (
            balance !== null &&
            (balance <= 0 || balance < Number(this.amount))
        ) {
            setAlert({
                title: 'COMMON.PLACEBET.ERROR.3',
                type: 'error',
            });
        } else {
            if (this.roundId) {
                setAlert({
                    title: 'Game has already started from another tab',
                    type: 'error',
                });

                return;
            }
            return await this.createGame();
        }
    };

    @action resetGame = () => {
        runInAction(() => {
            this.opened = [];
            this.tiles.replace(range(this.deskSize).map((v) => null));
            this.setResult(null, 0, 0);
            if (!this.turboModeEnabled) {
                this.setHit(0);
            }
            this.gameStarted = false;
            this.betPlaced = false;
            this.isOpenedTable = false;
        });
    };

    @action resetTiles = () => {
        runInAction(() => {
            this.tiles.replace(range(this.deskSize).map((v) => null));
            this.autobetTiles.replace(range(this.deskSize).map((v) => null));
            if (this.turboModeEnabled) {
                this.setAutobetTilesDefaults(0);
            }
            this.setHit(0);
        });
    };

    @action cashout = async () => {
        if (!this.roundId) return;
        const {
            profile: { token, playerId },
            // updateBalance,
        } = this.root.profileCommon;

        try {
            this.betLoading = true;
            const resp = await cashoutRequest({
                headers: {
                    authorization: token,
                    apikey: playerId,
                },
                roundId: this.roundId,
            });
            const { coefficient, payout, result, mines } = resp.data;
            if (result) {
                this.setResult(result, payout, coefficient);
                this.openTable(mines);
            }
            const { setAllTournamentsNotUpdated } = this.root.tournamentsCommon;
            setAllTournamentsNotUpdated();
            this.betLoading = false;
            this.root.uiCommon.checkSettleError(resp, this.cancelGame);
        } catch (error) {
            this.root.uiCommon.checkErrorToResetGame(error, this.cancelGame);
            this.betLoading = false;
            this.setGame('');
            this.gameStarted = false;
            return error;
        }
    };

    @action setResult = (
        result: CashoutResponse['result'] | null,
        payout = 0,
        coefficient = 0,
    ) => {
        runInAction(() => {
            if (result) {
                this.myBetsUpdater += 1;
            }
            this.gameResult = result;
            this.payout = payout;
            this.coefficient = coefficient;
        });
    };

    @action createGame = async () => {
        const {
            clientSeed,
            serverSeed,
            nonce,
            minesAmount,
            root: {
                profileCommon: {
                    profile: { token, playerId },
                },
            },
        } = this;

        try {
            this.betLoading = true;
            const {
                data: { roundId },
            } = await createGameRequest({
                headers: {
                    authorization: token,
                    apikey: playerId,
                },
                clientSeed,
                nonce,
                size: Number(minesAmount),
                deskSize: this.deskSize,
                serverSeed,
                theme: getTheme() || 'default',
                //theme: 'default',
            });
            this.setGame(roundId);
            this.gameStarted = true;
            this.betLoading = false;
            return roundId;
        } catch (error) {
            console.log('fetchGame error:', error);
            this.betLoading = false;
            return error;
        }
    };

    @action retrieveGame = async () => {
        const {
            profileCommon: {
                profile: { token, playerId },
            },
            uiCommon: { setAlert },
        } = this.root;
        this.retrieveGameLoading = true;
        try {
            const {
                data: {
                    clientSeed,
                    hash,
                    nonce,
                    opened,
                    minesAmount,
                    amount,
                    deskSize = this.deskSize,
                    roundId,
                },
            } = await retriveGameRequest({
                headers: {
                    authorization: token,
                    apikey: playerId,
                },
                theme: getTheme() || 'default',
            });

            if (!clientSeed || !nonce || !opened || !minesAmount) {
                throw { clientSeed, hash, nonce, opened, minesAmount };
            }

            runInAction(() => {
                this.roundId = roundId;
                this.gameStarted = true;
                this.clientSeed = clientSeed;
                this.nonce = nonce;
                this.deskSize = deskSize;
                this.opened = opened;

                this.tiles.replace(range(deskSize).map((v) => null));

                this.tiles.replace(
                    this.tiles.map((t, i) => (opened.includes(i) ? 1 : t)),
                );

                this.setHit(opened.length);
                if (amount) {
                    this.betPlaced = true;
                    this.setAmount(String(amount));
                }
                this.setMinesAmount(minesAmount);
                this.mockGame();
                this.retrieveGameLoading = false;

                setAlert({
                    title: 'NOTIF.CONTINUE_ROUND',
                    type: 'success',
                });
            });
        } catch (error) {
            console.log('fetchGame error:', error);
            this.setGame('');
            this.gameStarted = false;
            this.retrieveGameLoading = false;
            return error;
        }
    };

    @action setGame = (roundId = '') => {
        this.roundId = roundId;
    };

    @action tapAutoBet = (index: number) => {
        const a = this.autobetIndexes.length;
        const h = this.hits.length;
        const allowIncrement = a < h;
        const newTiles = this.autobetTiles.map((tile, i) => {
            let newTile = tile;
            if (i === index) {
                if (tile !== null) {
                    this.decrementHit();
                    newTile = null;
                }
                if (tile === null && allowIncrement) {
                    this.incrementHit();
                    newTile = index;
                }
            }
            return newTile;
        });
        this.autobetTiles.replace(newTiles);
    };

    @action makeAutoBet = async () => {
        const {
            autobetCommon: {
                initialAmount,
                autoBetEnabled,
                autoBetLimit,
                autoBetsAmount,
                onWinIncrease,
                onWinIncreaseAmount,
                onLoseIncrease,
                onLoseIncreaseAmount,
                setAutoBetsAmount,
                stopOnAnyWin,
                setStopOnAnyWin,
            },
            profileCommon: {
                // updateBalance,
                limit: { maxBet },
            },
        } = this.root;

        if (!autoBetEnabled || (autoBetLimit && autoBetsAmount <= 0)) {
            this.stopAutoBet();
            return;
        }

        if (!this.autobetIndexes.length) return;

        try {
            await this.startGame();
            const { mines, result, payout, coefficient } =
                await this.placeMultiResp(this.autobetIndexes);

            if (autoBetLimit) {
                setAutoBetsAmount(String(autoBetsAmount - 1));
            }
            this.opened = this.autobetIndexes;
            if (mines) {
                this.tiles.replace(
                    this.tiles.map((t, i) => (mines.includes(i) ? 0 : 1)),
                );
            }

            if (result) {
                this.setResult(result, payout, coefficient);
            }
            // await updateBalance();
            if (autoBetEnabled) {
                if (result === 'won') {
                    if (stopOnAnyWin) {
                        await timeout(1);
                        this.stopAutoBet();
                        setStopOnAnyWin(false);
                    } else {
                        if (onWinIncrease && onWinIncreaseAmount > 0) {
                            const a =
                                (Number(this.amount) / 100) *
                                onWinIncreaseAmount;
                            const sum = Number(this.amount) + Number(a);
                            if (sum > maxBet) {
                                this.setAmount(maxBet.toFixed(2));
                            } else {
                                this.setAmount(sum.toFixed(2));
                            }
                        }
                        if (!onWinIncrease) {
                            this.setAmount(Number(initialAmount).toFixed(2));
                        }
                    }
                }
                if (result === 'lost') {
                    if (onLoseIncrease && onLoseIncreaseAmount > 0) {
                        const a =
                            (Number(this.amount) / 100) * onLoseIncreaseAmount;
                        const sum = Number(this.amount) + Number(a);
                        if (sum > maxBet) {
                            this.setAmount(maxBet.toFixed(2));
                        } else {
                            this.setAmount(sum.toFixed(2));
                        }
                    }
                    if (!onLoseIncrease) {
                        this.setAmount(Number(initialAmount).toFixed(2));
                    }
                }
            }
            await timeout(2);
            runInAction(() => {
                this.tiles.replace(range(this.deskSize).map((v) => null));
                this.setResult(null, 0, 0);
                this.gameStarted = false;
                this.opened = [];
            });
            this.setGame();
            this.makeAutoBet();
        } catch (error) {
            //@ts-ignore
            this.root.uiCommon.errorCodeResolver(error.response);
            this.stopAutoBet();
            this.resetGame();
        }
    };

    @action makeMultiBet = async (sound = true) => {
        const { playAudio } = this.root.audioCommon;
        if (!this.autobetIndexes.length) return;

        try {
            this.tapLoading = true;
            await this.startGame();
            const { mines, result, payout, coefficient } =
                await this.placeMultiResp(this.autobetIndexes);

            this.opened = this.autobetIndexes;

            if (mines) {
                this.tiles.replace(
                    this.tiles.map((t, i) => (mines.includes(i) ? 0 : 1)),
                );
            }
            if (result) {
                if (sound) {
                    if (result === 'lost') {
                        playAudio('bomb');
                    }
                    if (result === 'won' && this.currentCoefficient < 10) {
                        playAudio('cashout');
                    }
                }

                this.setResult(result, payout, coefficient);
            }
            this.tapLoading = false;
            this.resetTimeout = window.setTimeout(() => {
                runInAction(() => {
                    this.tiles.replace(range(this.deskSize).map((v) => null));
                    this.setResult(null, 0, 0);
                    this.gameStarted = false;
                    this.opened = [];
                });
                this.setGame();
            }, 2000);
        } catch (error) {
            this.root.uiCommon.errorCodeResolver(error.response);
            this.resetGame();
            this.tapLoading = false;
        }
    };

    @action tap = async (tile: number) => {
        const {
            profileCommon: {
                profile: { balance },
            },
            autobetCommon: { autoBetEnabled },
            uiCommon: { setAlert },
            tournamentsCommon: { addBet },
        } = this.root;
        if (autoBetEnabled) return;
        try {
            this.tapLoading = true;
            this.tapLoadingIndex = tile;
            const data = await this.tapRequest(tile);
            if (!this.hit) {
                this.betPlaced = true;
                // await updateBalance();
                addBet({
                    amount: Number(this.amount),
                    coefficient: this.coefficient,
                });
            }

            const { result, payout, coefficient, mines } = data;
            if (result === 'won' && mines) {
                const newTiles = this.tiles.map((item, i) => {
                    return i === tile ? 1 : item;
                });
                this.tiles.replace(newTiles);
                // last one tile condition
                this.setResult(result, payout, coefficient);
                this.openTable(mines);
                this.tapLoading = false;
                this.tapLoadingIndex = null;
                return;
            }

            this.openTile(data, tile);
            this.tapLoading = false;
            this.tapLoadingIndex = null;
        } catch (error) {
            this.root.uiCommon.errorCodeResolver(error.response);
            this.tapLoading = false;
            this.tapLoadingIndex = null;
            return error;
        }
    };

    @action placeMultiResp = async (opened: number[]) => {
        const {
            root: {
                profileCommon: {
                    profile: { token, playerId, currency, subPartnerId },
                },
                uiCommon: { isMobile },
            },
            roundId,
            serverSeed,
        } = this;

        if (!roundId) {
            throw new Error('no gameId');
        }
        try {
            const respond: { data: TapResponse } = await placeMultiTapRequest({
                headers: formatHeaders({
                    authorization: token,
                    apikey: playerId,
                    subpartnerid: subPartnerId,
                    metadata: JSON.stringify({
                        device: isMobile ? 'mobile' : 'desktop',
                        manual: false,
                    }),
                }),
                opened,
                roundId,
                theme: getTheme() || 'default',
                // theme: 'default',
                clientSeed: this.clientSeed,
                nonce: this.nonce,
                amount: Number(this.amount),
                currency,
                serverSeed,
                ...((process.env.THEME === 'turbomines' ||
                    process.env.THEME === 'testb') && {
                    tag: process.env.THEME === 'testb' ? 'b' : 'a',
                }),
            });

            return respond.data;
        } catch (error) {
            this.root.uiCommon.checkErrorToResetGame(error, this.cancelGame);
            throw error;
        }
    };

    @action tapRequest = async (tile: number) => {
        const {
            root: {
                profileCommon: {
                    profile: { token, playerId, subPartnerId, currency },
                },
                uiCommon: { isMobile },
            },
            serverSeed,
            roundId,
        } = this;

        if (!roundId) {
            throw new Error('no gameId');
        }

        const placeBetParams = this.hit
            ? {}
            : {
                  clientSeed: this.clientSeed,
                  nonce: this.nonce,
                  amount: Number(this.amount),
                  currency,
              };

        try {
            const respond: { data: TapResponse } = await placeBetRequest({
                headers: formatHeaders({
                    authorization: token,
                    apikey: playerId,
                    subpartnerid: subPartnerId,
                    metadata: JSON.stringify({
                        device: isMobile ? 'mobile' : 'desktop',
                        manual: true,
                    }),
                }),
                theme: getTheme() || 'default',
                // theme: 'default',
                roundId,
                index: tile,
                serverSeed,
                ...placeBetParams,
                ...((process.env.THEME === 'turbomines' ||
                    process.env.THEME === 'testb') && {
                    tag: process.env.THEME === 'testb' ? 'b' : 'a',
                }),
            });
            return respond.data;
        } catch (error) {
            this.root.uiCommon.checkErrorToResetGame(error, this.cancelGame);
            throw error;
            // throw new Error('tap tile error');
        }
    };

    @action startAutoBet = async () => {
        const {
            autobetCommon: {
                autoBetsAmount,
                setInitialAmount,
                setAutoBetEnabled,
                setAutoBetLimit,
            },
            profileCommon: {
                profile: { balance },
            },
            uiCommon: { setAlert },
        } = this.root;

        if (balance !== null && balance <= 0) {
            setAlert({
                title: 'COMMON.PLACEBET.ERROR.3',
                // title: 'COMMON.ERRORS.NOT_ENOUGH_MONEY',
                type: 'error',
            });
        } else {
            if (autoBetsAmount > 0) {
                setAutoBetLimit(true);
            }
            runInAction(() => {
                setInitialAmount(Number(this.amount));
                setAutoBetEnabled(true);
            });
            try {
                await this.makeAutoBet();
            } catch (error) {
                console.log({ error });
                this.stopAutoBet();
            }
        }
    };

    @action stopAutoBet = () => {
        const { setAutoBetEnabled, setAutoBetLimit } = this.root.autobetCommon;

        runInAction(() => {
            setAutoBetEnabled(false);
            setAutoBetLimit(false);
            this.autobetTiles.replace(range(this.deskSize).map((v) => null));
            if (this.turboModeEnabled) {
                this.setAutobetTilesDefaults();
            }
            this.setHit(0);
        });
    };

    @action retreiveAmount = () => {
        const {
            limit: { minBet, defaultBet },
            profile: { currency, balance },
        } = this.root.profileCommon;
        const amount = LS.get(`saved_amount:${currency}`);

        const a =
            amount && !isNaN(Number(amount))
                ? amount
                : defaultBet
                ? defaultBet
                : minBet * 10;
        if (!this.gameStarted) {
            this.amount = String(Math.min(Number(a), balance));
        }
    };

    @action setAmount = (amount: string) => {
        console.log('setAmount', amount);

        const {
            profile: { currency },
        } = this.root.profileCommon;
        LS.set(`saved_amount:${currency}`, amount);
        this.amount = String(amount);
    };

    @action setMinesAmount = (amount: number) => {
        this.minesAmount = `${amount}`;
        // if (this.turboModeEnabled) {
        //     this.autobetTiles.replace(range(this.deskSize).map((v) => null));
        //     if (this.hit) {
        //         this.setHit(0);
        //     }
        //     this.setAutobetTilesDefaults(0);
        // }
        // if (this.root.autobetCommon.autoModeEnabled) {
        //     this.autobetTiles.replace(range(this.deskSize).map((v) => null));
        // }
    };

    //
    @action openTable = async (mines: number[]) => {
        this.opened = this.tiles
            .map((item, index) => (typeof item === 'number' ? index : null))
            .filter((item): item is number => typeof item === 'number');
        this.tiles.replace(
            this.tiles.map((t, i) => (mines.includes(i) ? 0 : 1)),
        );
        this.isOpenedTable = true;
        // await timeout(3);
        this.setGame();
        this.resetTimeout = window.setTimeout(() => {
            this.resetGame();
        }, 3000);
    };

    @action setHit = (hit = 0) => {
        this.hit = hit;
    };

    @action incrementHit = () => {
        this.hit++;
    };

    @action decrementHit = () => {
        this.hit--;
    };

    @action openTile = async (
        {
            // index,
            status,
            result,
            mines,
        }: TapResponse,
        index: number,
    ) => {
        const { playAudio, stopAudio } = this.root.audioCommon;
        if (this.gameName === 'mines') {
            switch (status) {
                case 1: {
                    //win
                    stopAudio();
                    playAudio(`diamond${this.riskLevel}`);
                    break;
                }
                case 0: {
                    //lose
                    playAudio('bomb');
                    break;
                }
            }
        }
        if (this.gameName === 'turbomines') {
            switch (status) {
                case 1: {
                    //win
                    stopAudio();
                    playAudio(`diamond${this.turboRiskLevel}`);
                    break;
                }
                case 0: {
                    //lose
                    playAudio('bomb');
                    break;
                }
            }
        }
        if (this.gameName === 'jeuduchien') {
            switch (status) {
                case 1: {
                    //win
                    stopAudio();
                    playAudio(`open${this.riskLevel}`);
                    break;
                }
                case 0: {
                    //lose
                    stopAudio();
                    playAudio('lose');
                    break;
                }
            }
        }
        if (this.gameName === 'saopaulo') {
            const int = randomIntFromInterval(1, 3);
            switch (status) {
                case 1: {
                    //win
                    stopAudio();
                    playAudio(`x${int}`);
                    playAudio(`open${this.riskLevel}`);
                    break;
                }
                // case 0: {
                //     //lose
                //     stopAudio();
                //     playAudio('loseSP');
                //     break;
                // }
            }
        }

        if (this.gameName === 'dogstreet') {
            switch (status) {
                case 1: {
                    //win
                    stopAudio();
                    // const opensAudio = ['open1', 'open2', 'open3'];
                    const opensAudio = ['open0'];
                    playAudio(
                        opensAudio[
                            Math.floor(Math.random() * opensAudio.length)
                        ],
                    );
                    break;
                }
                // case 0: {
                //     //lose
                //     stopAudio();
                //     playAudio('bomb');
                //     break;
                // }
            }
        }

        const newTiles = this.tiles.map((tile, i) =>
            i === index ? status : tile,
        );

        this.tiles.replace(newTiles);
        this.incrementHit();
        if (result && mines) {
            this.gameResult = result;
            this.myBetsUpdater += 1;
            this.openTable(mines);
        }
    };

    @action fetchLimits = async () => {
        const {
            profile: { token, playerId },
            setLimit,
        } = this.root.profileCommon;

        try {
            const { data } = await getLimit({
                headers: {
                    authorization: token,
                    apikey: playerId,
                },
            });

            setLimit(data);
        } catch (error) {
            console.log('Auth error:', error);
        }
    };

    @computed get tableTouched() {
        return this.tiles.some((t) => t != null);
    }

    @computed get hits() {
        const {
            rtp,
            limit: { maxWin },
            profile: { rounding },
        } = this.root.profileCommon;
        return range(this.diamondsMax).map((v) => {
            const index = v + 1;
            // const coeff = 20;
            const coeff = getCoefficient(
                Number(this.minesAmount),
                index,
                this.deskSize,
                rtp,
            );
            return {
                index,
                coefficient: `x${toShortNumber(coeff)}`,
                active: this.hit === index,
                // payout: toShortNumber(floor(coeff * Number(this.amount))),
                payout: shortNumber(
                    floor(
                        Math.min(
                            maxWin + Number(this.amount),
                            coeff * Number(this.amount),
                        ),
                    ),
                    rounding,
                ),
            };
        });
    }

    @computed get possibleWin() {
        const {
            rtp,
            limit: { maxWin },
            profile: { currency },
        } = this.root.profileCommon;
        // const coeff = 20;
        const coeff = getCoefficient(
            Number(this.minesAmount),
            this.hit,
            this.deskSize,
            rtp,
        );
        let psblwn = 0;
        try {
            const amount = LS.get(`saved_amount:${currency}`);
            const a = Number(this.amount) || Number(amount);
            const win = floor(a * coeff);
            psblwn = Math.min(maxWin + a, win);
        } catch (error) {}
        return psblwn;
    }

    @computed get currentCoefficient() {
        const { rtp } = this.root.profileCommon;
        return getCoefficient(
            Number(this.minesAmount),
            this.hit,
            this.deskSize,
            rtp,
        );
    }

    @computed get possibleWinNext() {
        const {
            rtp,
            limit: { maxWin },
            profile: { rounding },
        } = this.root.profileCommon;
        let coeff = null;
        try {
            //TODO: WTF????
            coeff = getCoefficient(
                Number(this.minesAmount),
                this.hit + 1,
                this.deskSize,
                rtp,
            );
        } catch (error) {}
        const shortCoeff = coeff || 1;
        const win = floor(Number(this.amount) * shortCoeff);
        return Math.min(maxWin + Number(this.amount), win);
        // return shortNumber(
        //     Math.min(maxWin + Number(this.amount), win),
        //     rounding,
        // );
    }

    @computed get riskLevel() {
        const high = 5;
        const mid = 14;
        // const low = 19;
        // const crystals = this.deskSize - Number(this.minesAmount);
        const open = this.tiles.filter(Boolean).length + 1;

        const left = this.diamondsMax - open;
        if (left < mid && left > high) {
            return 2;
        }
        if (left <= high) {
            return 3;
        }
        return 1;
    }

    @computed get turboRiskLevel(): 1 | 2 | 3 {
        let level: 1 | 2 | 3 = 1;
        const part = Math.round(this.deskSize / 3);
        const lvl = this.hit + 1;
        switch (true) {
            case lvl <= part: {
                level = 1;
                break;
            }
            case lvl > part && lvl <= part * 2: {
                level = 2;
                break;
            }
            case lvl > part * 2: {
                level = 3;
                break;
            }
            default:
                break;
        }
        return level;
    }
}

export default Store;
