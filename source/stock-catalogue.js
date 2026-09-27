// Generated from scripts/stock-designs.json by the art generators.
setup.stockCatalogue = {
	"locomotives": [
		{
			"key": "dieselShunter",
			"model": "diesel-shunter",
			"origin": "Britain",
			"era": "1950s",
			"drivetrain": "diesel-electric",
			"region": "europe"
		},
		{
			"key": "dieselRoad",
			"model": "diesel-road",
			"origin": "United States",
			"era": "1970s",
			"drivetrain": "diesel-electric",
			"region": "americas"
		},
		{
			"key": "dieselOldRoad",
			"model": "diesel-old-road",
			"origin": "Soviet Union",
			"era": "1960s",
			"drivetrain": "diesel-electric",
			"region": "eurasia"
		},
		{
			"key": "steamShunter",
			"model": "steam-shunter",
			"origin": "Britain",
			"era": "1920s",
			"drivetrain": "steam",
			"region": "europe"
		},
		{
			"key": "steamPrairie",
			"model": "steam-prairie",
			"origin": "Poland",
			"era": "1950s",
			"drivetrain": "steam",
			"region": "europe"
		},
		{
			"key": "dieselMechanical",
			"model": "diesel-mechanical",
			"origin": "Germany",
			"era": "1930s",
			"drivetrain": "diesel-mechanical",
			"region": "europe",
			"base": "dieselShunter",
			"name": "two axle mechanical diesel",
			"length": 7,
			"baseWeight": 18000,
			"tractiveCapacity": 75,
			"topSpeedKmh": 30,
			"maxCargoCapacityKg": 680,
			"maxCargoCapacityVolume": 800,
			"dieselLitresPerMinute": 0.6,
			"design": "mechanical",
			"colours": [
				"#986856",
				"#724536",
				"#c3aa79"
			]
		},
		{
			"key": "dieselHydraulic",
			"model": "diesel-hydraulic",
			"origin": "Germany",
			"era": "1960s",
			"drivetrain": "diesel-hydraulic",
			"region": "europe",
			"base": "dieselShunter",
			"name": "four axle hydraulic diesel",
			"length": 13,
			"baseWeight": 63000,
			"tractiveCapacity": 180,
			"topSpeedKmh": 85,
			"maxCargoCapacityKg": 2300,
			"maxCargoCapacityVolume": 2700,
			"dieselLitresPerMinute": 3.5,
			"design": "hydraulic",
			"colours": [
				"#aa6b58",
				"#813d36",
				"#d7c9a5"
			]
		},
		{
			"key": "dieselCabUnit",
			"model": "diesel-cab-unit",
			"origin": "United States",
			"era": "1950s",
			"drivetrain": "diesel-electric",
			"region": "americas",
			"base": "dieselRoad",
			"name": "four axle cab diesel",
			"length": 17,
			"baseWeight": 105000,
			"tractiveCapacity": 250,
			"topSpeedKmh": 110,
			"maxCargoCapacityKg": 4100,
			"maxCargoCapacityVolume": 4800,
			"dieselLitresPerMinute": 6,
			"design": "cab-unit",
			"colours": [
				"#b3b3a1",
				"#7e8d88",
				"#bd6b46"
			]
		},
		{
			"key": "steamAmerican",
			"model": "steam-american",
			"origin": "United States",
			"era": "1880s",
			"drivetrain": "steam",
			"region": "americas",
			"base": "steamPrairie",
			"name": "4-4-0 old steam engine",
			"length": 17,
			"baseWeight": 56000,
			"tractiveCapacity": 100,
			"topSpeedKmh": 65,
			"maxCargoCapacityKg": 11000,
			"maxCargoCapacityVolume": 13000,
			"boilerSteamVolumeLiters": 30000,
			"fireboxScale": 1.5,
			"steamUseScale": 1.3,
			"design": "american",
			"colours": [
				"#657f67",
				"#344f40",
				"#bb9760"
			]
		},
		{
			"key": "steamStreamliner",
			"model": "steam-streamliner",
			"origin": "Britain",
			"era": "1930s",
			"drivetrain": "steam",
			"region": "europe",
			"base": "steamPrairie",
			"name": "4-6-2 streamlined steam engine",
			"length": 22,
			"baseWeight": 155000,
			"tractiveCapacity": 230,
			"topSpeedKmh": 130,
			"maxCargoCapacityKg": 23000,
			"maxCargoCapacityVolume": 26000,
			"boilerSteamVolumeLiters": 65000,
			"fireboxScale": 3.2,
			"steamUseScale": 2.8,
			"design": "streamliner",
			"colours": [
				"#7297a3",
				"#375e76",
				"#cbb77e"
			]
		},
		{
			"key": "steamMikado",
			"model": "steam-mikado",
			"origin": "Japan",
			"era": "1930s",
			"drivetrain": "steam",
			"region": "east-asia",
			"base": "steamPrairie",
			"name": "2-8-2 freight steam engine",
			"length": 20,
			"baseWeight": 125000,
			"tractiveCapacity": 220,
			"topSpeedKmh": 80,
			"maxCargoCapacityKg": 20000,
			"maxCargoCapacityVolume": 22000,
			"boilerSteamVolumeLiters": 48000,
			"fireboxScale": 2.8,
			"steamUseScale": 2.4,
			"design": "mikado",
			"colours": [
				"#616562",
				"#343b39",
				"#9d966f"
			]
		},
		{
			"key": "steamGarratt",
			"model": "steam-garratt",
			"origin": "South Africa / Britain",
			"era": "1950s",
			"drivetrain": "steam",
			"region": "africa",
			"base": "steamPrairie",
			"name": "double mountain articulated steam engine",
			"length": 28,
			"baseWeight": 190000,
			"tractiveCapacity": 350,
			"topSpeedKmh": 75,
			"maxCargoCapacityKg": 28000,
			"maxCargoCapacityVolume": 30000,
			"boilerSteamVolumeLiters": 80000,
			"fireboxScale": 4,
			"steamUseScale": 3.5,
			"design": "garratt",
			"colours": [
				"#62685b",
				"#353c33",
				"#ba8b5e"
			]
		}
	],
	"cars": {
		"boxcar": {
			"type": "boxcar",
			"length": 12,
			"variants": [
				{
					"id": "planked",
					"name": "planked goods van",
					"origin": "Britain",
					"era": "1930s",
					"region": "europe",
					"style": "wood",
					"colours": [
						"#aa916d",
						"#796346"
					]
				},
				{
					"id": "ribbed",
					"name": "ribbed steel boxcar",
					"origin": "China",
					"era": "1970s",
					"region": "east-asia",
					"style": "steel",
					"colours": [
						"#93997b",
						"#62694d"
					]
				}
			]
		},
		"flatcar": {
			"type": "flatcar",
			"length": 14,
			"variants": [
				{
					"id": "stakes",
					"name": "stake flatcar",
					"origin": "Sweden",
					"era": "1960s",
					"region": "europe",
					"style": "stakes",
					"colours": [
						"#ada285",
						"#7b795d"
					]
				}
			]
		},
		"tanker": {
			"type": "tanker car",
			"length": 14,
			"variants": [
				{
					"id": "banded",
					"name": "banded tank wagon",
					"origin": "Soviet Union",
					"era": "1960s",
					"region": "eurasia",
					"style": "banded",
					"colours": [
						"#bdad83",
						"#8a7957"
					]
				}
			]
		},
		"gondola": {
			"type": "gondola",
			"length": 13,
			"variants": [
				{
					"id": "high-sided",
					"name": "high-sided mineral wagon",
					"origin": "South Africa",
					"era": "1970s",
					"region": "africa",
					"style": "steel",
					"colours": [
						"#a08165",
						"#755440"
					]
				}
			]
		},
		"hopper": {
			"type": "hopper car",
			"length": 14,
			"variants": [
				{
					"id": "cylindrical",
					"name": "cylindrical grain hopper",
					"origin": "Canada",
					"era": "1970s",
					"region": "americas",
					"style": "cylindrical",
					"colours": [
						"#c2a15e",
						"#917337"
					]
				}
			]
		},
		"refrigerated": {
			"type": "refrigerated car",
			"length": 15,
			"variants": [
				{
					"id": "ice",
					"name": "ice-cooled refrigerator car",
					"origin": "United States",
					"era": "1920s",
					"region": "americas",
					"style": "ice",
					"colours": [
						"#d0bd8a",
						"#a49367"
					]
				}
			]
		},
		"passenger": {
			"type": "passenger coach",
			"length": 24,
			"variants": [
				{
					"id": "clerestory",
					"name": "clerestory passenger coach",
					"origin": "Britain",
					"era": "1910s",
					"region": "europe",
					"style": "clerestory",
					"colours": [
						"#9c8360",
						"#725535"
					]
				},
				{
					"id": "stainless",
					"name": "stainless passenger coach",
					"origin": "United States",
					"era": "1950s",
					"region": "americas",
					"style": "stainless",
					"colours": [
						"#bac3ba",
						"#899890"
					]
				},
				{
					"id": "suburban",
					"name": "suburban passenger coach",
					"origin": "Japan",
					"era": "1970s",
					"region": "east-asia",
					"style": "suburban",
					"colours": [
						"#9ba984",
						"#647b51"
					]
				}
			]
		},
		"sleeper": {
			"type": "sleeper coach",
			"length": 25,
			"variants": [
				{
					"id": "blue",
					"name": "blue sleeping car",
					"origin": "France",
					"era": "1930s",
					"region": "europe",
					"style": "compartment",
					"colours": [
						"#788e9e",
						"#3b526c"
					]
				},
				{
					"id": "green",
					"name": "green sleeping car",
					"origin": "Soviet Union",
					"era": "1960s",
					"region": "eurasia",
					"style": "compartment",
					"colours": [
						"#8b9472",
						"#4e603f"
					]
				}
			]
		},
		"observation": {
			"type": "observation car",
			"length": 23,
			"variants": [
				{
					"id": "dome",
					"name": "dome observation car",
					"origin": "United States",
					"era": "1950s",
					"region": "americas",
					"style": "dome",
					"colours": [
						"#b9bdb0",
						"#758881"
					]
				}
			]
		},
		"kitchen": {
			"type": "kitchen car",
			"length": 24,
			"variants": [
				{
					"id": "diner",
					"name": "red dining car",
					"origin": "Germany",
					"era": "1960s",
					"region": "europe",
					"style": "diner",
					"colours": [
						"#b08976",
						"#783f39"
					]
				}
			]
		},
		"private": {
			"type": "private car",
			"length": 22,
			"variants": [
				{
					"id": "saloon",
					"name": "wood-panelled saloon car",
					"origin": "Argentina",
					"era": "1910s",
					"region": "americas",
					"style": "saloon",
					"colours": [
						"#a49168",
						"#68563c"
					]
				}
			]
		}
	}
};
