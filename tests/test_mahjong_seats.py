import unittest
from unittest.mock import patch
import server


class MahjongSeatTests(unittest.TestCase):
    def setUp(self):
        self.hosts = {}
        self.seats = {}
        self.enterContext(patch.object(server, 'GAME_HOSTS', self.hosts))
        self.enterContext(patch.object(server, 'GAME_SEATS', self.seats))

    def test_no_phantom_room(self):
        self.assertEqual(server.claim_game_seat('expired', 'auto'), (None, 'ROOM_NOT_FOUND'))
        self.assertEqual(server.claim_game_seat('expired', '1'), (None, 'ROOM_NOT_FOUND'))
        self.assertEqual(server.claim_game_seat('new_room', '0'), (0, None))

    def test_auto_assigns_distinct_seats_and_reuses_freed_slots(self):
        room = 'table-1'
        self.hosts[room] = {99: True}
        self.seats[room] = {0: '房主'}
        with server.GAME_LOCK:
            for n in (1, 2, 3):
                self.assertEqual(server.claim_game_seat(room, 'auto'), (n, None))
                self.seats[room][n] = '来宾'
            self.assertEqual(server.claim_game_seat(room, 'auto'), (None, 'ROOM_FULL'))
            self.assertEqual(server.claim_game_seat(room, '2'), (None, 'SEAT_TAKEN'))
            del self.seats[room][2]
            self.assertEqual(server.claim_game_seat(room, 'auto'), (2, None))
