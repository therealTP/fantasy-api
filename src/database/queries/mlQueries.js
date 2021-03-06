import queryUtil from './../../util/queryUtil';
import config from './../../../config';
import moment from 'moment';

module.exports = {
    getModelAiDataForDate(gameDate, statType, isTraining, numRecentGames) {
        const seasonStart = config.SEASON_BOUND;
        return `-- NOTE: CONVERT ALL BOOLS TO TEXT FOR GOOGLE CSV --
                SELECT ${isTraining? "s." + statType + " as actual_stat, " : ""}pl.bref_id,
                -- TEAM PLAYER IS ON AT TIME OF PROJECTION
                t2.team_abbrev,
                -- PROJS FOR STAT --
                ${statType === 'tpt' ? '' : 'nf, '}bm, rw, fp,
                -- ALL PLAYER DATA & CHANGELOG DATA --
                pl.*,
                -- TEAM DATA --
                CAST(lg.won_game as text) as team_won_last_game, records.pct as team_winning_pct,
                -- GAME DATA --
                CASE WHEN g.home_team_id = pl.current_team_id THEN 'true' ELSE 'false' END AS is_home,
                CASE WHEN g.home_team_id = pl.current_team_id THEN
                    (SELECT team_abbrev FROM nba_teams WHERE team_id = g.away_team_id) ELSE
                    (SELECT team_abbrev FROM nba_teams WHERE team_id = g.home_team_id) END AS opponent_abbrev,
                CASE WHEN g.home_team_id = pl.current_team_id THEN g.home_spread ELSE -g.home_spread END AS team_spread,
                CASE WHEN g.home_team_id = pl.current_team_id THEN g.home_pred_pts ELSE g.away_pred_pts END AS team_pred_pts,
                -- GAME DATE & TIME --
                g.game_time_24_et, t1.tz_hrs_over_utc as game_tz, g.day_of_week, (g.game_date - '${seasonStart}') as days_into_season,
                -- GAME LAT & LNG
                ARRAY[t1.stadium_lat_n, t1.stadium_lng_w] AS game_lat_lng,
                -- INJURIES, ACCOUNT FOR EMPTY ARRS USING COALESCE --
                -- TODO: update this to count all players from each team that were injured on this date, use changelog table
                CASE WHEN g.home_team_id = pl.current_team_id THEN
                    COALESCE(ARRAY_LENGTH(g.home_team_injured, 1), 0)
                    ELSE
                    COALESCE(ARRAY_LENGTH(g.away_team_injured, 1), 0)
                    END AS num_teammates_injured,
                CASE WHEN g.home_team_id = pl.current_team_id THEN
                    COALESCE(ARRAY_LENGTH(g.away_team_injured, 1), 0)
                    ELSE
                    COALESCE(ARRAY_LENGTH(g.home_team_injured, 1), 0)
                    END AS num_opponents_injured,
                -- ATTENDANCE --
                (att.avg_att / 1000) as stadium_avg_att,
                LEAST(CAST(ROUND((CAST(att.avg_att as DECIMAL) / CAST(att.stadium_cap as DECIMAL)), 3) AS REAL), 1) as avg_att_pct,
                -- GAME LOCATION DATA, USED TO MEASURE DISTANCE TRAVELED (uses current team!) --
                t2.tz_hrs_over_utc as home_tz_over_utc, ARRAY[t2.stadium_lat_n, t2.stadium_lng_w]::REAL[] as home_lat_lng,
                -- RECENT STATS/ GAME INFO --
                CASE WHEN rs.last_game_played_id = lg.game_id THEN 'true' ELSE 'false' END AS played_in_last_team_game,
                CAST(rs.won_last_game_played as text) AS won_last_game_played, -- CONVERT TO STR --
                rs.recent_of_stat, rs.recent_mins, rs.recent_games_won, rs.recent_game_dates,
                rs.recent_game_times, rs.recent_time_zones, rs.recent_latlng

                --- CORE TABLE: GET PROJECTION DATA BY PLAYER FOR DATE & STAT TYPE --
                FROM (
                    SELECT player_id, game_id,
                    ${statType === 'tpt' ? '' : 'MAX(CASE WHEN source_id = 1 THEN ' + statType + " END) nf,"}
                    MAX(CASE WHEN source_id = 2 THEN ${statType} END) bm,
                    MAX(CASE WHEN source_id = 3 THEN ${statType} END) rw,
                    MAX(CASE WHEN source_id = 4 THEN ${statType} END) fp
                    FROM nba_projections
                    -- SELECT PROJECTIONS FROM GAMES ON THIS GAME DATE --
                    WHERE game_id IN (
                        SELECT game_id
                        FROM nba_games
                        WHERE game_date = '${gameDate}'
                    )
                    GROUP BY player_id, game_id ORDER BY 1
                ) p

                -- JOIN CORE TABLE #2: player data (also uses nba_player_changelog) --
                JOIN (
                    SELECT pl.player_id, pl.bref_id, ch.changed_on, ch.new_current_depth AS current_depth, 
                    ch.new_usual_depth AS usual_depth, ch.new_position AS player_position, ch.new_team AS current_team_id,
                    CASE WHEN ch.new_starting IS TRUE THEN 'true' ELSE 'false' END AS is_starter, 
                    ch.new_salary AS player_salary, ch.new_games_played AS games_played, ch.new_status AS player_status,
                    ch.new_inactive as player_inactive,
                    pl.height, pl.weight, pl.draft_pick,
                    ((DATE_PART('year', '${gameDate}'::date) - DATE_PART('year', pl.dob::date)) * 12 +
                    (DATE_PART('month', '${gameDate}'::date) - DATE_PART('month', pl.dob::date))) AS age,
                    ((DATE_PART('year', '${gameDate}'::date) - DATE_PART('year', pl.debut_date::date)) * 12 +
                    (DATE_PART('month', '${gameDate}'::date) - DATE_PART('month', pl.debut_date::date))) AS exp_months
                    FROM nba_players pl
                    LEFT OUTER JOIN (
                    SELECT DISTINCT ON (player_id) *
                    FROM nba_player_changelog
                    WHERE changed_on BETWEEN '${seasonStart}' AND (DATE '${gameDate}' + interval '1' DAY)
                    ORDER BY player_id ASC, changed_on DESC
                    ) as ch on ch.player_id = pl.player_id
                ) pl ON pl.player_id = p.player_id

                -- GAME DATA FOR GAME ID
                JOIN nba_games g ON g.game_id = p.game_id

                -- TEAM DATA FOR HOME TEAM (lat/lng, tz, etc)
                JOIN nba_teams t1 ON t1.team_id = g.home_team_id

                -- GET ACTUAL STATS FOR TRAINING --
                JOIN nba_stats AS s ON s.player_id = p.player_id AND s.game_id = g.game_id

                -- JOIN ON TEAM THAT PLAYER WAS ON AT THE TIME OF THE PROJECTION --
                LEFT JOIN nba_teams t2 ON t2.team_id = pl.current_team_id

                -- #### PAST DATA #### ----
                    
                -- GET LAST GAME FOR TEAM --
                JOIN (
                    SELECT t.team_id as team_id, team_abbrev, g.game_id as game_id, g.game_date,
                    CASE WHEN (t.team_id = g.home_team_id AND g.home_team_won IS TRUE) OR
                            (t.team_id = g.away_team_id AND g.home_team_won IS FALSE)
                            THEN TRUE ELSE FALSE END as won_game
                    FROM nba_teams t
                    JOIN nba_games g
                    ON g.game_id = (
                        SELECT gp.game_id
                        FROM nba_games gp
                        WHERE
                            (gp.away_team_id = t.team_id OR gp.home_team_id = t.team_id)
                            AND gp.game_date < '${gameDate}' AND gp.game_date > '${seasonStart}'
                        ORDER BY gp.game_date DESC
                        LIMIT 1
                    )
                ) as lg ON lg.team_id = pl.current_team_id

                -- GET AVERAGE ATTENDANCE DATA FOR STADIUMS BEFORE GIVEN DATE/ AFTER BEGINNING OF SEASON --
                JOIN (
                    SELECT home_team_id, t.stadium_capacity AS stadium_cap, CAST(ROUND(AVG(attendance)) AS INT) as avg_att
                    FROM nba_games g
                    JOIN nba_teams t
                        ON t.team_id = g.home_team_id
                    WHERE game_date < '${gameDate}' AND game_date > '${seasonStart}' AND attendance IS NOT NULL
                    GROUP BY home_team_id, stadium_cap
                ) as att on att.home_team_id = g.home_team_id

                -- GET WINNING PCT FOR TEAMS AT TIME OF GAME --
                JOIN (
                    WITH games_won AS (
                        SELECT
                            CASE WHEN home_team_won
                            THEN home_team_id
                            ELSE away_team_id END AS team_id,
                            count(CASE WHEN home_team_won
                            THEN home_team_id
                                ELSE away_team_id END) AS wins
                        FROM nba_games
                        WHERE game_date < '${gameDate}' AND game_date > '${seasonStart}'
                        GROUP BY team_id
                    )

                    SELECT gw.team_id AS team_id, CAST(ROUND((1.0 * wins) / (1.0 * wins + 1.0 * losses), 3) as REAL) as pct

                    FROM games_won gw

                    JOIN (
                        SELECT
                        CASE WHEN home_team_won THEN away_team_id ELSE home_team_id END AS team_id,
                        count(CASE WHEN home_team_won THEN away_team_id ELSE home_team_id END) AS losses
                        FROM nba_games
                        WHERE game_date < '${gameDate}' AND game_date > '${seasonStart}'
                        GROUP BY team_id
                    ) as gl
                    ON gl.team_id = gw.team_id
                ) AS records ON records.team_id = pl.current_team_id

                -- RECENT GAME DATE FOR PLAYER: mins, stat, wins, game_dates, game_times, time_zones, lat/lng
                JOIN (
                    SELECT player_id, (ARRAY_AGG(game_id))[1] as last_game_played_id, (ARRAY_AGG(team_won))[1] as won_last_game_played,
                        ARRAY_AGG(${statType}) as recent_of_stat, ARRAY_AGG(mins) as recent_mins,
                        ARRAY_AGG(team_won) AS recent_games_won, ARRAY_AGG(game_date)::TEXT[] as recent_game_dates,
                        ARRAY_AGG(game_time) as recent_game_times, ARRAY_AGG(tz) as recent_time_zones,
                        ARRAY_AGG(ARRAY[lat, lng]::REAL[]) as recent_latlng
                    FROM (
                        SELECT CAST (row_num AS INTEGER ) AS row_num, player_id, ${statType}, ROUND(CAST(mins AS numeric), 2) as mins, team_id, game_id, team_won, tz, lat, lng, game_date, game_time
                        -- replace "pts" above with statType
                        FROM (
                            SELECT
                            ROW_NUMBER()
                            OVER ( PARTITION BY player_id
                            ORDER BY g.game_date DESC ) AS row_num,
                            st.*,
                            g.game_date AS game_date,
                            g.game_time_24_et AS game_time,
                            t.tz_hrs_over_utc AS tz,
                            t.stadium_lat_n AS lat,
                            t.stadium_lng_w AS lng,
                            CASE WHEN ((st.team_id = g.home_team_id AND g.home_team_won IS TRUE )
                            OR (st.team_id = g.away_team_id AND g.home_team_won IS FALSE ))
                            THEN TRUE ELSE FALSE END AS team_won
                            FROM nba_stats st
                            JOIN nba_games g
                                ON st.game_id = g.game_id
                            JOIN nba_teams t
                                ON t.team_id = g.home_team_id
                            WHERE g.game_date < '${gameDate}' AND g.game_date > '${seasonStart}' -- SUB THIS OUT FOR DATE IN QUERY TEMPLATE STR
                            AND st.mins > 0 -- only get games where player played > 0 mins
                        ) stats
                        WHERE row_num <= 10 -- SUB THIS OUT FOR # ROWS PARAM
                        ORDER BY player_id, game_date DESC
                    ) AS recent_games

                    GROUP BY player_id
                ) as rs on rs.player_id = p.player_id

                -- ONLY PULL VALS WHERE ALL PROJ SRCS ARE PRESENT --
                WHERE ${statType === 'tpt' ? '' : 'nf IS NOT NULL AND '}bm IS NOT NULL AND rw IS NOT NULL AND fp IS NOT NULL;`
    },
    getModelAiDataForToday(statType) {
        const today = moment().tz('US/Pacific').format('YYYY-MM-DD');
        const seasonStart = config.SEASON_BOUND;

        return `SELECT pl.bref_id,
                -- PROJS FOR STAT --
                ${statType === 'tpt' ? '' : 'nf, '}bm, rw, fp,
                -- DEPTH/STARTER --
                pl.current_depth_pos,
                -- IF NO CURRENT DEPTH POS, USE P.DEPTH_POS (WON'T HAPPEN W/ LIVE)
                CASE WHEN pl.usual_depth_pos IS NOT NULL THEN pl.usual_depth_pos ELSE pl.current_depth_pos END AS usual_depth_pos,
                CAST(pl.is_starter as text),
                -- PLAYER DETAILS --
                pl.player_position, pl.height, pl.weight, pl.draft_pick, pl.games_played, pl.current_salary / 10000 as current_salary,
                ((DATE_PART('year', '${today}'::date) - DATE_PART('year', pl.dob::date)) * 12 +
                (DATE_PART('month', '${today}'::date) - DATE_PART('month', pl.dob::date))) AS age,
                ((DATE_PART('year', '${today}'::date) - DATE_PART('year', pl.debut_date::date)) * 12 +
                (DATE_PART('month', '${today}'::date) - DATE_PART('month', pl.debut_date::date))) AS exp_months,
                -- TEAM DATA --
                t.team_abbrev, CAST(lg.won_game as text) as team_won_last_game, records.pct as team_winning_pct,
                -- GAME DATA --
                CASE WHEN g.home_team_id = pl.current_team THEN 'true' ELSE 'false' END AS is_home,
                CASE WHEN g.home_team_id = pl.current_team THEN
                    (SELECT team_abbrev FROM nba_teams WHERE team_id = g.away_team_id) ELSE
                    (SELECT team_abbrev FROM nba_teams WHERE team_id = g.home_team_id) END AS opponent_abbrev,
                CASE WHEN g.home_team_id = pl.current_team THEN g.home_spread ELSE -g.home_spread END AS team_spread,
                CASE WHEN g.home_team_id = pl.current_team THEN g.home_pred_pts ELSE g.away_pred_pts END AS team_pred_pts,
                -- GAME DATE & TIME --
                g.game_time_24_et, g.day_of_week, to_char(g.game_date, 'MON') as game_month, t1.tz_hrs_over_utc as game_tz,
                -- GAME LAT & LNG
                ARRAY[t1.stadium_lat_n, t1.stadium_lng_w] AS game_lat_lng,
                -- INJURIES --
                CASE WHEN g.home_team_id = pl.current_team THEN
                    -- IF HOME TEAM IS CURRENT TEAM, GET COUNT OF HOME TEAM
                    (SELECT COUNT(*) FROM nba_players WHERE current_team = g.home_team_id AND inactive = TRUE AND status != 'NOT_ON_ROSTER') ELSE
                --     IF AWAY TEAM IS CURRENT TEAM, GET COUNT OF AWAY TEAM
                    (SELECT COUNT(*) FROM nba_players WHERE current_team = g.away_team_id AND inactive = TRUE AND status != 'NOT_ON_ROSTER') END AS num_teammates_injured,

                CASE WHEN g.home_team_id = pl.current_team THEN
                    -- IF HOME TEAM IS CURRENT TEAM, GET COUNT OF AWAY TEAM
                    (SELECT COUNT(*) FROM nba_players WHERE current_team = g.away_team_id AND inactive = TRUE AND status != 'NOT_ON_ROSTER') ELSE
                    -- IF AWAY TEAM IS CURRENT TEAM, GET COUNT OF HOME TEAM
                    (SELECT COUNT(*) FROM nba_players WHERE current_team = g.home_team_id AND inactive = TRUE AND status != 'NOT_ON_ROSTER') END AS num_opponents_injured,
                -- ATTENDANCE --
                att.avg_att / 1000 as stadium_avg_att,
                CAST(ROUND((CAST(att.avg_att as DECIMAL) / CAST(att.stadium_cap as DECIMAL)), 3) AS REAL) as avg_att_pct,
                -- HOME LOCATION DATA --
                t.tz_hrs_over_utc as home_tz_over_utc, ARRAY[t.stadium_lat_n, t.stadium_lng_w]::REAL[] as home_lat_lng,
                -- RECENT STATS --
                CASE WHEN rs.last_game_played_id = lg.game_id THEN 'true' ELSE 'false' END AS played_in_last_team_game,
                CAST(rs.won_last_game_played as text) AS won_last_game_played, -- CONVERT TO STR --
                rs.recent_of_stat, rs.recent_mins, rs.recent_games_won, rs.recent_game_dates,
                rs.recent_game_times, rs.recent_time_zones, rs.recent_latlng

                --- CORE TABLE: GET PROJECTION DATA BY PLAYER FOR DATE & STAT TYPE --
                FROM (
                    SELECT player_id, game_id, team_id, depth_pos, is_starter,
                    ${statType === 'tpt' ? '' : 'MAX(CASE WHEN source_id = 1 THEN ' + statType + " END) nf,"}
                    MAX(CASE WHEN source_id = 2 THEN ${statType} END) bm,
                    MAX(CASE WHEN source_id = 3 THEN ${statType} END) rw,
                    MAX(CASE WHEN source_id = 4 THEN ${statType} END) fp
                    FROM nba_projections
                    -- SELECT PROJECTIONS FROM GAMES ON THIS GAME DATE --
                    WHERE game_id IN (
                        SELECT game_id
                        FROM nba_games
                        WHERE game_date = '${today}'
                    )
                    GROUP BY player_id, game_id, team_id, depth_pos, is_starter ORDER BY 1
                ) p

                JOIN nba_players pl ON pl.player_id = p.player_id
                JOIN nba_games g ON g.game_id = p.game_id
                JOIN nba_teams t1 ON t1.team_id = g.home_team_id

                -- GET ACTUAL STATS FOR TRAINING --
                -- JOIN nba_stats AS s ON s.player_id = p.player_id AND s.game_id = g.game_id

                -- JOIN ON TEAM THAT PLAYER WAS ON AT THE TIME OF THE PROJECTION --
                -- NOTE: WILL GET IN REAL TIME WHEN CALCULATED PROJECTIONS IN REAL TIME --
                LEFT JOIN nba_teams t ON t.team_id = pl.current_team

                -- GET LAST GAME FOR TEAM --
                JOIN (
                    SELECT t.team_id as team_id, team_abbrev, g.game_id as game_id, g.game_date,
                    CASE WHEN (t.team_id = g.home_team_id AND g.home_team_won IS TRUE) OR
                            (t.team_id = g.away_team_id AND g.home_team_won IS FALSE)
                            THEN TRUE ELSE FALSE END as won_game
                    FROM nba_teams t
                    JOIN nba_games g
                    ON g.game_id = (
                        SELECT gp.game_id
                        FROM nba_games gp
                        WHERE
                            (gp.away_team_id = t.team_id OR gp.home_team_id = t.team_id)
                            AND gp.game_date < '${today}' AND gp.game_date > '${seasonStart}'
                        ORDER BY gp.game_date DESC
                        LIMIT 1
                    )
                ) as lg ON lg.team_id = pl.current_team

                -- GET AVERAGE ATTENDANCE DATA FOR STADIUMS & JOIN --
                JOIN (
                    SELECT home_team_id, t.stadium_capacity AS stadium_cap, CAST(ROUND(AVG(attendance)) AS INT) as avg_att
                    FROM nba_games g
                    JOIN nba_teams t
                        ON t.team_id = g.home_team_id
                    WHERE game_date < '${today}' AND game_date > '${seasonStart}'
                    AND attendance IS NOT NULL
                    GROUP BY home_team_id, stadium_cap
                ) as att on att.home_team_id = g.home_team_id

                -- GET WINNING PCT FOR TEAMS AT TIME OF GAME --
                JOIN (
                    WITH games_won AS (
                        SELECT
                            CASE WHEN home_team_won
                            THEN home_team_id
                            ELSE away_team_id END AS team_id,
                            count(CASE WHEN home_team_won
                            THEN home_team_id
                                ELSE away_team_id END) AS wins
                        FROM nba_games
                        WHERE game_date < '${today}' AND game_date > '${seasonStart}'
                        GROUP BY team_id
                    )

                    SELECT gw.team_id AS team_id, CAST(ROUND((1.0 * wins) / (1.0 * wins + 1.0 * losses), 3) as REAL) as pct

                    FROM games_won gw

                    JOIN (
                        SELECT
                        CASE WHEN home_team_won THEN away_team_id ELSE home_team_id END AS team_id,
                        count(CASE WHEN home_team_won THEN away_team_id ELSE home_team_id END) AS losses
                        FROM nba_games
                        WHERE game_date < '${today}' AND game_date > '${seasonStart}'
                        GROUP BY team_id
                    ) as gl
                    ON gl.team_id = gw.team_id
                ) AS records ON records.team_id = pl.current_team

                -- REPLACE PTS W / QUERY STRING
                JOIN (
                SELECT player_id, (ARRAY_AGG(game_id))[1] as last_game_played_id, (ARRAY_AGG(team_won))[1] as won_last_game_played,
                    ARRAY_AGG(${statType}) as recent_of_stat, ARRAY_AGG(mins) as recent_mins, -- replace "pts" with statType
                    ARRAY_AGG(team_won) AS recent_games_won, ARRAY_AGG(game_date)::TEXT[] as recent_game_dates,
                    ARRAY_AGG(game_time) as recent_game_times, ARRAY_AGG(tz) as recent_time_zones,
                    ARRAY_AGG(ARRAY[lat, lng]::REAL[]) as recent_latlng
                FROM (
                    SELECT CAST (row_num AS INTEGER ) AS row_num, player_id, ${statType}, ROUND(CAST(mins AS numeric), 2) as mins, team_id, game_id, team_won, tz, lat, lng, game_date, game_time
                    -- replace "pts" above with statType
                    FROM (
                    SELECT
                    ROW_NUMBER()
                    OVER ( PARTITION BY player_id
                    ORDER BY g.game_date DESC ) AS row_num,
                    st.*,
                    g.game_date AS game_date,
                    g.game_time_24_et AS game_time,
                    t.tz_hrs_over_utc AS tz,
                    t.stadium_lat_n AS lat,
                    t.stadium_lng_w AS lng,
                    CASE WHEN ((st.team_id = g.home_team_id AND g.home_team_won IS TRUE )
                    OR (st.team_id = g.away_team_id AND g.home_team_won IS FALSE ))
                    THEN TRUE ELSE FALSE END AS team_won
                    FROM nba_stats st
                    JOIN nba_games g
                    ON st.game_id = g.game_id
                    JOIN nba_teams t
                    ON t.team_id = g.home_team_id
                    WHERE g.game_date < '${today}' AND g.game_date > '${seasonStart}' -- SUB THIS OUT FOR DATE IN QUERY TEMPLATE STR
                    AND st.mins > 0
                    ) stats
                    WHERE row_num <= 10 -- SUB THIS OUT FOR # ROWS PARAM
                    ORDER BY player_id, game_date DESC
                ) AS recent_games

                GROUP BY player_id
                ) as rs on rs.player_id = pl.player_id

                -- ONLY PULL VALS WHERE ALL SRCS ARE PRESENT --
                WHERE ${statType === 'tpt' ? '' : 'nf IS NOT NULL AND'}bm IS NOT NULL AND rw IS NOT NULL AND fp IS NOT NULL;`
    }
};
