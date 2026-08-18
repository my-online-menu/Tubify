from setuptools import setup

setup(
    name="ytmp3",
    version="0.1.0",
    packages=["ytmp3"],
    entry_points={
        "console_scripts": [
            "ytmp3 = ytmp3.main:main",
        ]
    },
)
